import requests
import logging
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from odoo import api, fields, models, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Cashdro S has a very limited embedded HTTP server (single-threaded).
# When it's busy (counting coins, etc.) it cannot accept new TCP connections.
# We use retries with exponential backoff to handle these transient failures.
CASHDRO_CONNECT_TIMEOUT = 20  # seconds to wait for TCP connection
CASHDRO_READ_TIMEOUT = 30  # seconds to wait for response data
CASHDRO_MAX_RETRIES = 3
CASHDRO_BACKOFF_FACTOR = 2  # wait 2s, 4s, 8s between retries


def _get_cashdro_session():
    """Create a requests Session with automatic retry and backoff for Cashdro."""
    session = requests.Session()
    retry_strategy = Retry(
        total=CASHDRO_MAX_RETRIES,
        backoff_factor=CASHDRO_BACKOFF_FACTOR,
        status_forcelist=[502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    def _get_payment_terminal_selection(self):
        return super()._get_payment_terminal_selection() + [("cashdro", "Cashdro")]

    cashdro_host = fields.Char(
        string="Cashdro Terminal Host Name or IP address",
        help="It must be reachable by the PoS in the store",
    )
    cashdro_user = fields.Char()
    cashdro_password = fields.Char()

    def _onchange_journal_id(self):
        """Cash payment method force the `use_payment_terminal` to `False` as
        it's assumed that a cash journal can't have a payment terminal. Let's keep
        the method when it's needed"""
        res = super()._onchange_journal_id()
        if self.use_payment_terminal != "cashdro" and not self.is_cash_count:
            return res
        self.use_payment_terminal = "cashdro"

    def _compute_hide_use_payment_terminal(self):
        """Now that we have the option to choose a payment terminal for the cashdro
        payments, we can show the terminal options for cash payment types."""
        cash_payment_types = self.filtered(lambda x: x.type == "cash")
        cash_payment_types.hide_use_payment_terminal = False
        return super(
            PosPaymentMethod, self - cash_payment_types
        )._compute_hide_use_payment_terminal()

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        params += ["cashdro_host", "cashdro_user", "cashdro_password"]
        return params

    def action_test_cashdro_connection(self):
        self.ensure_one()
        _logger.info(
            "Testing Cashdro connection for %s at %s", self.name, self.cashdro_host
        )
        if not self.cashdro_host:
            raise UserError(_("Cashdro Host is not defined."))

        url = f"{self.cashdro_host}/Cashdro3WS/index.php"
        params = {
            "name": self.cashdro_user,
            "password": self.cashdro_password,
            "operation": "askOperation",
            "operationId": "0",
        }

        session = _get_cashdro_session()
        try:
            _logger.info("Cashdro Request URL: %s", url)
            _logger.info("Cashdro Request Params: %s", params)
            response = session.get(
                url,
                params=params,
                timeout=(CASHDRO_CONNECT_TIMEOUT, CASHDRO_READ_TIMEOUT),
            )
            _logger.info("Cashdro Response Status: %s", response.status_code)
            _logger.info("Cashdro Response Body: %s", response.text)

            if response.status_code == 200:
                return {
                    "type": "ir.actions.client",
                    "tag": "display_notification",
                    "params": {
                        "title": _("Success"),
                        "message": _(
                            "Connection successful! Response: %s"
                        )
                        % response.text[:100],
                        "type": "success",
                        "sticky": False,
                    },
                }
            else:
                return {
                    "type": "ir.actions.client",
                    "tag": "display_notification",
                    "params": {
                        "title": _("Error"),
                        "message": _(
                            "Connection failed with status %s"
                        )
                        % response.status_code,
                        "type": "danger",
                        "sticky": False,
                    },
                }
        except requests.exceptions.ConnectionError as e:
            _logger.error(
                "Cashdro Connection Error (retries exhausted): %s", str(e)
            )
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Connection Error"),
                    "message": _(
                        "Could not connect to Cashdro after %d retries. "
                        "The device may be busy or unreachable. Error: %s"
                    )
                    % (CASHDRO_MAX_RETRIES, str(e)),
                    "type": "danger",
                    "sticky": True,
                },
            }
        except requests.exceptions.Timeout as e:
            _logger.error("Cashdro Timeout Error: %s", str(e))
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Timeout Error"),
                    "message": _(
                        "Cashdro did not respond within %d seconds. "
                        "The device may be busy processing another operation. "
                        "Error: %s"
                    )
                    % (CASHDRO_CONNECT_TIMEOUT, str(e)),
                    "type": "danger",
                    "sticky": True,
                },
            }
        except Exception as e:
            _logger.error("Cashdro Unexpected Error: %s", str(e))
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Connection Error"),
                    "message": str(e),
                    "type": "danger",
                    "sticky": False,
                },
            }
        finally:
            session.close()


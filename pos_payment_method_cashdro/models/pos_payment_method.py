import requests
import logging
from odoo import fields, models, _
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


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

    def action_test_cashdro_connection(self):
        self.ensure_one()
        _logger.info("Testing Cashdro connection for %s at %s", self.name, self.cashdro_host)
        if not self.cashdro_host:
            raise UserError(_("Cashdro Host is not defined."))

        url = f"{self.cashdro_host}/Cashdro3WS/index.php"
        params = {
            "name": self.cashdro_user,
            "password": self.cashdro_password,
            "operation": "askOperation",
            "operationId": "0",
        }

        try:
            _logger.info("Cashdro Request URL: %s", url)
            _logger.info("Cashdro Request Params: %s", params)
            response = requests.get(url, params=params, timeout=10)
            _logger.info("Cashdro Response Status: %s", response.status_code)
            _logger.info("Cashdro Response Body: %s", response.text)

            if response.status_code == 200:
                return {
                    "type": "ir.actions.client",
                    "tag": "display_notification",
                    "params": {
                        "title": _("Success"),
                        "message": _("Connection successful! Response: %s") % response.text[:100],
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
                        "message": _("Connection failed with status %s") % response.status_code,
                        "type": "danger",
                        "sticky": False,
                    },
                }
        except Exception as e:
            _logger.error("Cashdro Connection Error: %s", str(e))
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

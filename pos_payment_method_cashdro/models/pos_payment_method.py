import logging
from odoo import api, fields, models, _

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

    @api.model
    def _load_pos_data_fields(self, config):
        params = super()._load_pos_data_fields(config)
        params += ["cashdro_host", "cashdro_user", "cashdro_password"]
        return params

    def action_test_cashdro_connection(self):
        """Return connection parameters so the browser-side JS can test the
        CashDro directly.  The Odoo server (especially when running in Docker
        or in the cloud) cannot reach private-network IPs like 192.168.x.x.
        The browser of the user configuring the payment method *is* in the
        local network, so the test must run there."""
        self.ensure_one()
        if not self.cashdro_host:
            from odoo.exceptions import UserError
            raise UserError(_("Cashdro Host is not defined."))
        return {
            "type": "ir.actions.client",
            "tag": "cashdro_test_connection",
            "params": {
                "host": self.cashdro_host,
                "user": self.cashdro_user,
                "password": self.cashdro_password,
            },
        }


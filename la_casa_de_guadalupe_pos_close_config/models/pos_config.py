# -*- coding: utf-8 -*-

from odoo import api, fields, models

class PosConfig(models.Model):
    _inherit = 'pos.config'

    pos_close_pin = fields.Char(
        string='PIN de Cierre',
        help='PIN de seguridad requerido para cerrar la sesión del POS.',
    )

    @api.model
    def _load_pos_data_fields(self, config):
        fields = super()._load_pos_data_fields(config)
        if fields:
            fields.append('pos_close_pin')
        return fields

# -*- coding: utf-8 -*-

from odoo import fields, models

class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_pos_close_pin = fields.Char(
        related='pos_config_id.pos_close_pin',
        readonly=False,
        string='PIN de Cierre de Caja',
        help='PIN de seguridad requerido para autorizar el cierre de la caja.',
    )

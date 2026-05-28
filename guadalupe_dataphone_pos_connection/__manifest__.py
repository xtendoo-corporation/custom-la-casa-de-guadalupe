# Copyright 2026 Xtendoo - Manuel Calero
# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
{
    "name": "Guadalupe Dataphone POS Connection (Ingenico AXIUM DX4000)",
    "summary": "Integración del datáfono Ingenico AXIUM DX4000 (CaixaBank/Comercia) con el TPV de Odoo",
    "version": "19.0.1.0.0",
    "category": "Point Of Sale",
    "website": "https://xtendoo.es",
    "author": "Xtendoo",
    "license": "AGPL-3",
    "depends": [
        "point_of_sale",
    ],
    "data": [
        "security/ir.model.access.csv",
        "views/pos_payment_method_views.xml",
        "views/pos_config_views.xml",
    ],
    "assets": {
        "point_of_sale._assets_pos": [
            "guadalupe_dataphone_pos_connection/static/src/js/payment_dataphone.esm.js",
            "guadalupe_dataphone_pos_connection/static/src/js/models.esm.js",
            "guadalupe_dataphone_pos_connection/static/src/xml/payment_dataphone.xml",
            "guadalupe_dataphone_pos_connection/static/src/css/payment_dataphone.css",
        ],
        "web.assets_backend": [
            "guadalupe_dataphone_pos_connection/static/src/js/dataphone_test_connection.esm.js",
        ],
    },
    "installable": True,
    "application": False,
    "auto_install": False,
}

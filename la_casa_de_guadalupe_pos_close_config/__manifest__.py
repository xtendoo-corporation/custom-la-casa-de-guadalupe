# -*- coding: utf-8 -*-
{
    'name': 'La Casa de Guadalupe POS Session Close PIN Configuration',
    'version': '19.0.1.0.0',
    'category': 'Point of Sale',
    'summary': 'Requiere PIN de seguridad para cerrar la sesión del POS',
    'description': """
        La Casa de Guadalupe POS Session Close PIN Configuration
        ========================================================

        Este módulo añade una capa de seguridad al proceso de cierre del POS.
        Añade un campo de configuración de PIN en la configuración de la caja (pos.config).
        Cuando un usuario intenta cerrar la caja, se le solicitará introducir dicho PIN.
        Si es incorrecto, el proceso de cierre no continuará.
    """,
    'author': 'Xtendoo',
    'website': 'https://www.xtendoo.es',
    'license': 'AGPL-3',
    'depends': [
        'point_of_sale',
    ],
    'data': [
        'views/pos_config_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'la_casa_de_guadalupe_pos_close_config/static/src/app/services/pos_store.js',
        ],
    },
    'installable': True,
    'auto_install': False,
    'application': False,
}

# -*- coding: utf-8 -*-
{
    'name': 'La Casa de Guadalupe POS Preticket',
    'version': '19.0.1.0.0',
    'category': 'Point of Sale',
    'summary': 'Añade un botón en el POS para imprimir un preticket del pedido en curso',
    'description': """
        La Casa de Guadalupe POS Preticket
        ===================================

        Este módulo añade un botón "Preticket" en el Punto de Venta que permite
        imprimir el pedido en curso (aún sin cobrar) utilizando la misma
        impresión de ticket que se usa habitualmente al finalizar la venta.

        Es útil para mostrar al cliente un justificante provisional del pedido
        antes de proceder al cobro, sin que ello afecte al circuito normal de
        venta ni al ticket definitivo.

        Mientras el pedido no está cobrado (finalizado), la cabecera del
        ticket muestra "TICKET" en lugar de "FACTURA SIMPLIFICADA", para no
        inducir a confusión con un documento fiscal.
    """,
    'author': 'Xtendoo',
    'website': 'https://www.xtendoo.es',
    'license': 'AGPL-3',
    'depends': [
        'point_of_sale',
        'xtendoo_pos_receipt',
    ],
    'data': [],
    'assets': {
        'point_of_sale._assets_pos': [
            'guadalupe_pos_preticket/static/src/app/screens/product_screen/control_buttons/control_buttons.js',
            'guadalupe_pos_preticket/static/src/app/screens/product_screen/control_buttons/control_buttons.xml',
            'guadalupe_pos_preticket/static/src/app/screens/receipt_screen/receipt/receipt_header.xml',
        ],
    },
    'installable': True,
    'auto_install': False,
    'application': False,
}

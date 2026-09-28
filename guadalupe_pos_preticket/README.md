# La Casa de Guadalupe POS Preticket

Módulo para Odoo 19 que añade un botón "Preticket" en el Punto de Venta.

## Qué hace

Añade un botón en el menú de acciones del POS (icono "⋮" / "More") que
imprime el pedido en curso **sin cobrarlo ni finalizarlo**, usando el mismo
mecanismo de impresión de ticket (`OrderReceipt`) que ya se usa al validar
una venta.

Es el mismo mecanismo estándar que usa Odoo para el botón "Bill" de
`pos_restaurant`, pero sin depender de ese módulo ni de la configuración de
restaurante: llama directamente a `pos.printReceipt({ printBillActionTriggered: true })`.

## Comportamiento

- No modifica el pedido, no lo marca como pagado ni lo sincroniza como venta.
- No incrementa el contador de impresiones del ticket definitivo (`nb_print`).
- Usa la misma impresora (hardware proxy o impresión web) ya configurada en
  el POS.
- El botón se deshabilita si el pedido no tiene líneas.
- Oculto para el rol de cajero "minimal", igual que el resto de acciones
  secundarias del POS.

## Instalación

1. El módulo está en:
   `odoo/custom/src/custom-la-casa-de-guadalupe/guadalupe_pos_preticket/`
2. Actualizar la lista de aplicaciones (modo desarrollador).
3. Buscar e instalar "La Casa de Guadalupe POS Preticket".

## Uso

1. Abre el POS y añade líneas al pedido en curso.
2. Pulsa el botón de acciones "⋮" (More).
3. Pulsa "Preticket" para imprimir el justificante provisional.
4. Continúa con el cobro normalmente; el ticket definitivo se imprime igual
   que siempre al finalizar el pago.

## Autor

**Xtendoo**
- Website: https://www.xtendoo.es

## Licencia

AGPL-3

/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { NumberPopup } from "@point_of_sale/app/components/popups/number_popup/number_popup";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";

patch(PosStore.prototype, {
    async closeSession() {
        if (this.config.pos_close_pin) {
            const response = await makeAwaitable(this.dialog, NumberPopup, {
                title: _t("PIN de Cierre Requerido"),
                subtitle: _t("Por favor, introduzca el PIN de seguridad para cerrar la sesión"),
                startingValue: "",
                formatDisplayedValue: (val) => "•".repeat(val.length),
            });

            if (response === undefined) {
                // Cancelled or dialog closed
                return;
            }

            if (response !== this.config.pos_close_pin) {
                this.notification.add(_t("PIN incorrecto. Acceso denegado al cierre de sesión."), {
                    type: "danger",
                });
                return;
            }
        }
        return super.closeSession(...arguments);
    }
});

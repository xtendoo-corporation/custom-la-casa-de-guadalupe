/** @odoo-module */
/* Copyright 2026 Xtendoo - Manuel Calero
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl). */

/**
 * ============================================================
 *  MÓDULO: Datáfono Ingenico AXIUM DX4000 para Odoo POS
 * ============================================================
 *
 * Arquitectura de comunicación:
 *
 *   POS Browser (JS)
 *       │  HTTP POST (JSON)
 *       ▼
 *   Servidor Odoo  (controlador /dataphone/transaction/start)
 *       │  TCP Socket (protocolo OPOS/Nexo)
 *       ▼
 *   Datáfono Ingenico AXIUM DX4000  (IP local de la tienda)
 *
 * El navegador no puede conectar directamente al datáfono porque:
 *   1. Los datáfonos usan sockets TCP, no HTTP
 *   2. Las políticas de seguridad del navegador lo impiden
 *   3. El servidor Odoo actúa como proxy seguro
 */

import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { _t } from "@web/core/l10n/translation";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de configuración
// ─────────────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 1000;          // Intervalo de polling de estado (1 seg)
const POLL_MAX_TIMEOUT_MS = 3 * 60 * 1000;  // Timeout máximo: 3 minutos
const REQUEST_TIMEOUT_MS = 120000;      // Timeout HTTP para la transacción (120 seg)

export class PaymentDataphone extends PaymentInterface {

    setup() {
        super.setup(...arguments);
        this.supports_reversals = true;
        this._current_transaction_id = null;
        this._polling_timer = null;
        this._is_cancelling = false;
        console.log("[Dataphone-LOG] 🚀 Módulo Ingenico AXIUM DX4000 inicializado.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FLUJO PRINCIPAL: Iniciar pago
    // ─────────────────────────────────────────────────────────────────────────
    sendPaymentRequest() {
        super.sendPaymentRequest(...arguments);
        const order = this.pos.getOrder();
        const line = order.getSelectedPaymentline();

        if (!line) {
            console.error("[Dataphone-LOG] ❌ No hay línea de pago seleccionada.");
            return Promise.resolve(false);
        }

        console.log(
            "[Dataphone-LOG] 💳 Iniciando pago con datáfono.",
            "Orden:", order.name,
            "Importe:", line.amount, "€"
        );

        line.setPaymentStatus("waitingCard");
        return this._dataphone_send_payment(order, line);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FLUJO PRINCIPAL: Cancelar pago
    // ─────────────────────────────────────────────────────────────────────────
    sendPaymentCancel() {
        super.sendPaymentCancel(...arguments);
        return this._dataphone_cancel_payment();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FLUJO PRINCIPAL: Reversal / Devolución
    // ─────────────────────────────────────────────────────────────────────────
    sendPaymentReversal() {
        super.sendPaymentReversal(...arguments);
        const order = this.pos.getOrder();
        const line = order.getSelectedPaymentline();

        if (!line) return Promise.resolve(false);

        console.log("[Dataphone-LOG] 🔄 Iniciando devolución en datáfono.");
        line.setPaymentStatus("waitingCard");
        return this._dataphone_send_payment(order, line, "refund");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMPLEMENTACIÓN: Enviar transacción al servidor Odoo
    // ─────────────────────────────────────────────────────────────────────────
    async _dataphone_send_payment(order, payment_line, transaction_type = "sale") {
        const method = payment_line.payment_method_id;
        const amount_cents = Math.round(Math.abs(payment_line.amount) * 100);

        if (amount_cents <= 0) {
            this._dataphone_show_error(
                _t("Importe inválido"),
                _t("El importe a cobrar debe ser mayor que 0.")
            );
            payment_line.setPaymentStatus("retry");
            return false;
        }

        if (!method.dataphone_host) {
            this._dataphone_show_error(
                _t("Datáfono no configurado"),
                _t("No se ha configurado la IP del datáfono en el método de pago. "
                   "Ve a Punto de Venta → Configuración → Métodos de pago.")
            );
            payment_line.setPaymentStatus("retry");
            return false;
        }

        console.log(
            "[Dataphone-LOG] 📡 Enviando al servidor Odoo →",
            `${amount_cents} céntimos (${transaction_type})`,
            `al datáfono ${method.dataphone_host}:${method.dataphone_port}`
        );

        try {
            // El servidor Odoo hace el trabajo de conectar con el datáfono via TCP
            const response = await this._dataphone_rpc("/dataphone/transaction/start", {
                payment_method_id: method.id,
                amount: amount_cents,
                transaction_type: transaction_type,
            });

            return this._dataphone_handle_response(response, payment_line);

        } catch (error) {
            console.error("[Dataphone-LOG] ❌ Error en la petición al servidor:", error);
            payment_line.setPaymentStatus("retry");
            this._dataphone_show_error(
                _t("Error de comunicación"),
                _t("No se pudo contactar con el servidor de pagos: %s", String(error.message || error))
            );
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMPLEMENTACIÓN: Cancelar transacción
    // ─────────────────────────────────────────────────────────────────────────
    async _dataphone_cancel_payment() {
        const order = this.pos.getOrder();
        const payment_line = order.getSelectedPaymentline();

        if (this._is_cancelling) return false;
        this._is_cancelling = true;

        console.log("[Dataphone-LOG] ⛔ Enviando cancelación al datáfono...");

        try {
            const method = payment_line?.payment_method_id;
            if (method?.id) {
                await this._dataphone_rpc("/dataphone/transaction/cancel", {
                    payment_method_id: method.id,
                });
            }
        } catch (e) {
            console.warn("[Dataphone-LOG] Advertencia al cancelar:", e.message);
        } finally {
            this._is_cancelling = false;
        }

        payment_line?.setPaymentStatus("retry");
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMPLEMENTACIÓN: Gestionar respuesta del datáfono
    // ─────────────────────────────────────────────────────────────────────────
    _dataphone_handle_response(response, payment_line) {
        if (!response) {
            console.error("[Dataphone-LOG] ❌ Respuesta vacía del servidor.");
            payment_line.setPaymentStatus("retry");
            this._dataphone_show_error(
                _t("Sin respuesta"),
                _t("El datáfono no devolvió ninguna respuesta. "
                   "Comprueba que el terminal está encendido y conectado.")
            );
            return false;
        }

        if (response.success && response.approved) {
            // ✅ PAGO APROBADO
            console.log(
                "[Dataphone-LOG] ✅ PAGO APROBADO",
                "Auth:", response.authorization_code,
                "Tarjeta:", response.card_type, "****" + response.card_last_digits
            );

            // Guardar datos del pago en la línea para el ticket
            payment_line.transaction_id = response.authorization_code;
            payment_line.card_type = response.card_type;
            payment_line.card_last_digits = response.card_last_digits;
            payment_line.response_code = response.response_code;

            payment_line.setPaymentStatus("done");
            return true;

        } else {
            // ❌ PAGO DENEGADO
            const error_msg = response.error || _t("Transacción denegada por el banco.");
            console.warn("[Dataphone-LOG] ❌ PAGO DENEGADO:", error_msg, "Código:", response.response_code);

            payment_line.setPaymentStatus("retry");
            this._dataphone_show_error(
                _t("Pago denegado"),
                error_msg
            );
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILIDADES: Comunicación con el servidor Odoo
    // ─────────────────────────────────────────────────────────────────────────
    async _dataphone_rpc(endpoint, params) {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "call",
                params: params,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.data?.message || data.error.message || "Error del servidor");
        }

        return data.result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILIDADES: Mostrar error en diálogo
    // ─────────────────────────────────────────────────────────────────────────
    _dataphone_show_error(title, body) {
        this.env.services.dialog.add(AlertDialog, {
            title: title,
            body: body,
        });
    }
}

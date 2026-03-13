/** @odoo-module */
/* Copyright 2021 Tecnativa - David Vidal
   License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).*/

import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { PaymentInterface } from "@point_of_sale/app/utils/payment/payment_interface";
import { _t } from "@web/core/l10n/translation";

// Constantes de reintento
const CASHDRO_REQUEST_MAX_RETRIES = 3;
const CASHDRO_REQUEST_INITIAL_DELAY = 2000;
const CASHDRO_POLL_INITIAL_INTERVAL = 1000;
const CASHDRO_POLL_MAX_INTERVAL = 5000;
const CASHDRO_POLL_GLOBAL_TIMEOUT = 5 * 60 * 1000;
const CASHDRO_POLL_MAX_ERRORS = 5;

// Reintentos cuando la máquina devuelve "Operation not queued"
// Esperas: 2s, 4s, 6s, 8s, 10s — total máximo ~30s antes de rendirse
const CASHDRO_NOT_QUEUED_MAX_RETRIES = 5;
const CASHDRO_NOT_QUEUED_DELAY = 2000;

export class PaymentCashdro extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.supports_reversals = true;
        this._last_operation_id = null;
        console.log("[Cashdro-LOG] Componente inicializado correctamente.");
    }

    sendPaymentRequest() {
        super.sendPaymentRequest(...arguments);
        const order = this.pos.getOrder();
        const line = order.getSelectedPaymentline();
        console.log("[Cashdro-LOG] Botón 'Pagar' pulsado. Pedido:", order.uuid);
        console.log("[Cashdro-LOG] Importe en la línea de pago Odoo:", line.amount);

        line.setPaymentStatus("waiting");
        return this.cashdro_send_payment_request(order);
    }

    async cashdro_send_payment_request(order) {
        const payment_line = order.getSelectedPaymentline();

        try {
            const amount_cents = Math.round(Math.abs(payment_line.amount) * 100);
            console.log("[Cashdro-LOG] Preparando venta para importe (céntimos):", amount_cents);

            if (amount_cents <= 0) {
                throw new Error("El importe es 0 o negativo. La máquina no se activará.");
            }

            const base_url = this._cashdro_base_url();
            if (!base_url) {
                throw new Error("No se pudo construir la URL del Cashdro. Revisa la configuración del método de pago.");
            }

            const method = order.getSelectedPaymentline().payment_method_id;

            // Cerrar operación pendiente si tenemos el ID guardado
            if (this._last_operation_id) {
                console.log("[Cashdro-LOG] Cerrando operación pendiente guardada:", this._last_operation_id);
                await this._cashdro_silent_finish(this._last_operation_id, base_url, method);
                this._last_operation_id = null;
                await new Promise((r) => setTimeout(r, 1000));
            }

            const payment_params = this._cashdro_payment_params({ amount: amount_cents }, method);

            // PASO 1: startOperation con reintentos si la máquina no está lista
            const res = await this._cashdro_start_with_retries(base_url, payment_params, method);

            return await this._cashdro_continue(res, base_url, method, payment_line);

        } catch (error) {
            console.error("[Cashdro-LOG] FALLO EN EL PROCESO:", error);
            payment_line.setPaymentStatus("retry");
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Fallo de Conexión CashDro"),
                body: _t("Mira la consola (F12) para ver el error: %s", error.message || error),
            });
            return false;
        }
    }

    // Intenta startOperation hasta CASHDRO_NOT_QUEUED_MAX_RETRIES veces.
    // Cuando la máquina devuelve -2 "Operation not queued" simplemente espera
    // y reintenta — la máquina puede estar en un estado transitorio entre operaciones.
    async _cashdro_start_with_retries(base_url, payment_params, method) {
        for (let attempt = 1; attempt <= CASHDRO_NOT_QUEUED_MAX_RETRIES; attempt++) {
            const res = await this._cashdro_request(base_url, payment_params);
            console.log(`[Cashdro-LOG] startOperation intento ${attempt}:`, res);

            if (res && res.code === 1) {
                return res; // ✅ éxito
            }

            if (res && res.code === -2) {
                // Máquina en estado transitorio — esperar y reintentar
                const delay = CASHDRO_NOT_QUEUED_DELAY * attempt;
                console.warn(`[Cashdro-LOG] Máquina no lista (intento ${attempt}/${CASHDRO_NOT_QUEUED_MAX_RETRIES}). Esperando ${delay}ms...`);

                if (attempt === CASHDRO_NOT_QUEUED_MAX_RETRIES) {
                    throw new Error(
                        `La máquina Cashdro no está lista después de ${CASHDRO_NOT_QUEUED_MAX_RETRIES} intentos. ` +
                        `Espera unos segundos y vuelve a intentarlo.`
                    );
                }

                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            // Cualquier otro error
            throw new Error("Error en startOperation: " + JSON.stringify(res));
        }
    }

    async _cashdro_continue(res, base_url, method, payment_line) {
        const operation_id = String(res.data).trim();
        console.log("[Cashdro-LOG] ID de operación recibido:", operation_id);

        if (!operation_id || isNaN(operation_id)) {
            throw new Error("El ID de operación recibido no es válido: " + operation_id);
        }

        this._last_operation_id = operation_id;
        this.pos.getOrder().cashdro_operation = operation_id;

        // PASO 2: Acknowledge
        const ack_params = this._cashdro_ack_params(operation_id, method);
        console.log("[Cashdro-LOG] Enviando Acknowledge...");
        const ack_res = await this._cashdro_request(base_url, ack_params);
        console.log("[Cashdro-LOG] Acknowledge OK. Respuesta:", ack_res);

        // PASO 3: Polling
        const ask_params = this._cashdro_ask_params(operation_id, method);
        console.log("[Cashdro-LOG] Iniciando bucle de espera (Polling)...");
        const operation_data = await this._cashdro_request_payment(base_url, ask_params);
        console.log("[Cashdro-LOG] ¡Pago completado! Datos finales:", operation_data);

        payment_line.cashdro_operation_data = operation_data;

        const rawAmount = operation_data.totalin || operation_data.amountIn || operation_data.AmountIn || operation_data.amount;
        const tendered = rawAmount ? (parseFloat(rawAmount) / 100) : payment_line.amount;
        console.log("[Cashdro-LOG] Total introducido por el cliente (€):", tendered);

        if (!isNaN(tendered)) {
            payment_line.setAmount(tendered);
        }
        payment_line.setPaymentStatus("done");
        console.log("[Cashdro-LOG] Pago finalizado con éxito en Odoo.");

        // Esperar un momento antes de cerrar para que la máquina termine de procesar
        await new Promise((r) => setTimeout(r, 1500));
        await this._cashdro_silent_finish(operation_id, base_url, method);
        this._last_operation_id = null;
        this.pos.getOrder().cashdro_operation = false;
        return true;
    }

    async _cashdro_silent_finish(op_id, base_url, method) {
        try {
            const finish_params = this._cashdro_finish_params(op_id, method);
            const res = await this._cashdro_xhr_quick(base_url, finish_params);
            console.log("[Cashdro-LOG] finishOperation ID", op_id, "→", res);
        } catch (e) {
            console.log("[Cashdro-LOG] finishOperation silenciado (no crítico):", e.message);
        }
    }

    _cashdro_base_url() {
        const order = this.pos.getOrder();
        const method = order?.getSelectedPaymentline()?.payment_method_id;

        if (!method?.cashdro_host) {
            console.error("[Cashdro-LOG] ERROR: No se encuentra la IP del Cashdro.");
            return false;
        }

        let host = method.cashdro_host;
        if (!host.startsWith('http://') && !host.startsWith('https://')) {
            host = 'https://' + host;
        }

        return `${host}/Cashdro3WS/index.php`;
    }

    _cashdro_payment_params(parameters, method) {
        const params = JSON.stringify({ amount: String(parameters.amount) });
        return {
            aliasId: "",
            isManual: "1",
            name: method.cashdro_user,
            operation: "startOperation",
            parameters: params,
            password: method.cashdro_password,
            startnow: "true",
            type: "4",
        };
    }

    _cashdro_ack_params(op_id, method) {
        return {
            name: method.cashdro_user,
            operation: "acknowledgeOperationId",
            operationId: op_id,
            password: method.cashdro_password,
        };
    }

    _cashdro_ask_params(op_id, method) {
        return {
            name: method.cashdro_user,
            operation: "askOperation",
            operationId: op_id,
            password: method.cashdro_password,
        };
    }

    _cashdro_finish_params(op_id, method) {
        return {
            name: method.cashdro_user,
            operation: "finishOperation",
            operationId: op_id,
            password: method.cashdro_password,
            type: "2",
        };
    }

    _cashdro_parse_response(raw) {
        if (!raw) return null;
        if (raw.data && typeof raw.data === "string") {
            try {
                return JSON.parse(raw.data);
            } catch (e) {
                console.warn("[Cashdro-LOG] No se pudo parsear raw.data como JSON:", raw.data);
                return raw;
            }
        }
        return raw.data || raw;
    }

    _cashdro_xhr_quick(base_url, params) {
        return new Promise((resolve, reject) => {
            const query = new URLSearchParams(params).toString();
            const url = `${base_url}?${query}`;
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);
            xhr.timeout = 5000;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
            xhr.onload = () => {
                try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(xhr.responseText); }
            };
            xhr.onerror = () => reject(new Error("XHR error en operación rápida"));
            xhr.ontimeout = () => reject(new Error("XHR timeout en operación rápida"));
            xhr.send();
        });
    }

    _cashdro_xhr(base_url, params) {
        return new Promise((resolve, reject) => {
            const query = new URLSearchParams(params).toString();
            const url = `${base_url}?${query}`;
            console.log("[Cashdro-LOG] XHR POST a:", url);

            const xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);
            xhr.timeout = 30000;
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("Accept", "application/json, text/plain, */*");

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    console.log("[Cashdro-LOG] XHR respuesta:", xhr.responseText);
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        resolve(xhr.responseText);
                    }
                } else {
                    reject(new Error(`Error HTTP: ${xhr.status}`));
                }
            };
            xhr.onerror = () => reject(new Error("Error de red (XHR). Comprueba que el Cashdro es accesible."));
            xhr.ontimeout = () => reject(new Error("Timeout de conexión con el Cashdro."));
            xhr.send();
        });
    }

    async _cashdro_request(base_url, params) {
        let lastError;
        for (let attempt = 1; attempt <= CASHDRO_REQUEST_MAX_RETRIES; attempt++) {
            try {
                return await this._cashdro_xhr(base_url, params);
            } catch (error) {
                lastError = error;
                console.warn(`[Cashdro-LOG] Intento ${attempt} fallido:`, error.message);
                if (attempt < CASHDRO_REQUEST_MAX_RETRIES) {
                    await new Promise((r) => setTimeout(r, CASHDRO_REQUEST_INITIAL_DELAY));
                }
            }
        }
        throw lastError;
    }

    async _cashdro_request_payment(base_url, params) {
        let pollInterval = CASHDRO_POLL_INITIAL_INTERVAL;
        let errors = 0;
        const startTime = Date.now();

        while (true) {
            if (Date.now() - startTime > CASHDRO_POLL_GLOBAL_TIMEOUT) {
                console.error("[Cashdro-LOG] TIMEOUT: Se han superado los 5 minutos de espera.");
                throw new Error("Tiempo de espera agotado.");
            }

            try {
                const raw = await this._cashdro_xhr(base_url, params);
                const data = this._cashdro_parse_response(raw);
                console.log("[Cashdro-LOG] Estado actual de la máquina:", data?.operation?.state);

                if (data?.operation?.state === "F") {
                    console.log("[Cashdro-LOG] ¡Estado F detectado! Operación completada.");
                    return data.operation;
                }

                if (data?.operation?.state === "C" || String(data?.operation?.canceled) === "1" || String(data?.operation?.error) === "1") {
                    console.error("[Cashdro-LOG] Operación cancelada o con error.", data?.operation);
                    throw new Error("Operación cancelada o abortada por error en Cashdro.");
                }

            } catch (error) {
                errors++;
                console.warn("[Cashdro-LOG] Error durante la espera (Polling):", error.message);
                if (errors >= CASHDRO_POLL_MAX_ERRORS) throw error;
            }

            await new Promise((r) => setTimeout(r, pollInterval));
            pollInterval = Math.min(pollInterval + 500, CASHDRO_POLL_MAX_INTERVAL);
        }
    }
}

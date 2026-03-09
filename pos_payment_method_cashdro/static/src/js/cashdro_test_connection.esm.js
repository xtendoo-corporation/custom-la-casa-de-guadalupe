/** @odoo-module */

import { registry } from "@web/core/registry";
import { Component, xml } from "@odoo/owl";

class CashdroTestConnection extends Component {
    static template = xml`<div/>`;
    static props = ["*"];

    setup() {
        const params = this.props.action.params || {};
        this._runTest(params);
    }

    async _runTest(params) {
        let { host, user, password } = params;

        if (!host) {
            this.env.services.notification.add("El Host de CashDro no está definido.", {
                title: "Error",
                type: "danger",
            });
            this._goBack();
            return;
        }

        // FORZAR HTTP: Si el host viene con https, lo cambiamos a http
        // Esto es necesario mientras no actives los certificados SSL en el equipo.
        let targetHost = host.replace(/^https:\/\//i, 'http://');
        
        // Si no tiene protocolo, se lo añadimos
        if (!targetHost.startsWith('http://')) {
            targetHost = 'http://' + targetHost;
        }

        const cashdro_url =
            `${targetHost}/Cashdro3WS/index.php` +
            `?name=${encodeURIComponent(user || "")}` +
            `&password=${encodeURIComponent(password || "")}` +
            `&operation=askOperation&operationId=0`;

        this.env.services.notification.add(
            "Conectando directamente al CashDro desde este equipo...",
            { title: "CashDro Local", type: "info" }
        );

        console.log(`[CashDro] Intentando conexión local a: ${cashdro_url}`);

        try {
            // PETICIÓN DIRECTA DESDE EL NAVEGADOR
            const response = await fetch(cashdro_url, {
                method: 'GET',
                mode: 'cors', // Intentar saltar restricciones de origen
                cache: 'no-cache'
            });

            if (response.ok) {
                const textData = await response.text();
                console.log("[CashDro] Respuesta recibida:", textData);

                this.env.services.notification.add(
                    "¡Conexión exitosa! El navegador ha alcanzado el CashDro correctamente.",
                    { title: "Éxito", type: "success", sticky: false }
                );
            } else {
                throw new Error(`Código de respuesta: ${response.status}`);
            }
        } catch (error) {
            console.error("[CashDro] Error de conexión directa:", error);
            this.env.services.notification.add(
                "Error de conexión: El navegador no puede llegar a la IP local. " +
                "Asegúrate de permitir 'Contenido no seguro' en la configuración de Chrome para este sitio.",
                { title: "Fallo de conexión", type: "danger", sticky: true }
            );
        }

        this._goBack();
    }

    _goBack() {
        this.env.services.action.doAction({ type: "ir.actions.act_window_close" });
    }
}

registry.category("actions").add("cashdro_test_connection", CashdroTestConnection);

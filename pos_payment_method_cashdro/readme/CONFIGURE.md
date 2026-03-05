Para añadir un terminal de pago Cashdro:

1. Ve a **Punto de Venta > Configuración > Métodos de Pago**
2. Elige un método de pago en efectivo o crea uno nuevo.
3. Selecciona **Cashdro** en el campo **Usar un Terminal de Pago**.
4. Configura el hostname/IP del terminal Cashdro y sus credenciales (nombre de usuario y
   contraseña).
5. Configura el terminal Cashdro deseado en la configuración del Punto de Venta
   correspondiente.

Ten en cuenta que si se utilizaba un único método de pago en efectivo para diferentes
tiendas, deberá dividirse en tantos métodos de pago como tiendas físicas existan.

## Requisitos de Red (Odoo Cloud a CashDro Local)

Cuando Odoo está alojado en la Nube y el dispositivo CashDro se encuentra en la red
local de la tienda física (LAN, ej. `192.168.1.x`), **se debe establecer** un túnel
seguro o VPN. De lo contrario, Odoo no podrá conectarse y generará errores de "timeout".

Recomendamos usar **Tailscale** para configurar rápidamente el Enrutamiento de Subred
(Subnet Routing):

1. Instala Tailscale en el servidor Cloud de Odoo
   (`curl -fsSL https://tailscale.com/install.sh | sh`).
2. Instala Tailscale en el PC TPV con Windows de la tienda física.
3. En el PC Windows, abre **Símbolo del sistema (CMD) o PowerShell como Administrador**
   y anuncia la subred local de la tienda:
   `tailscale up --advertise-routes=192.168.1.0/24` _(cámbialo por tu subred real)_.
4. En la consola de administración web de Tailscale, ve a la configuración de Máquinas y
   **Aprueba (Approve)** la ruta de la subred en el dispositivo Windows.
5. En la configuración del Método de Pago de Odoo, mantén la IP LAN real del CashDro
   (ej. `192.168.1.50`). A partir de ahora, el servidor Odoo podrá comunicarse sin
   problemas a través del túnel Tailscale.

### Nota para Entornos Docker / Doodba

Si tu Odoo se ejecuta dentro de un contenedor Docker (como un entorno **Doodba**),
normalmente es suficiente con instalar Tailscale directamente en el Host (servidor Linux
base), **siempre y cuando el reenvío de IP (IP forwarding) esté habilitado** para que
los contenedores Docker puedan enrutar tráfico a través de la interfaz `tailscale0`
hacia la subred de la tienda.

Como alternativa (y recomendada), puedes ejecutar Tailscale como un contenedor "sidecar"
dentro de tu `docker-compose.yml`:

```yaml
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: odoocloud-tailscale
    environment:
      - TS_AUTHKEY=tskey-auth-your-key-here
      - TS_ROUTES=192.168.1.0/24 # Acepta rutas desde la tienda
    network_mode: "service:odoo" # Se conecta directamente al espacio de red de Odoo
    cap_add:
      - net_admin
      - sys_module
```

Al utilizar este enfoque de "sidecar" con `network_mode: "service:odoo"`, el contenedor
de Odoo tendrá acceso nativo a la red de Tailscale y a la IP del Cashdro sin tocar las
reglas del servidor Host.

**Cómo obtener la TS_AUTHKEY para despliegues con Docker:**

El valor `TS_AUTHKEY` permite que el contenedor se una a tu red de Tailscale
automáticamente al arrancar, sin que tengas que iniciar sesión manualmente.

1. Inicia sesión en tu consola web de Tailscale
   [`login.tailscale.com`](https://login.tailscale.com).
2. Ve al menú **Settings > Keys**.
3. Haz clic en **Generate auth key**. Recomendamos crear una clave de tipo **Reusable**
   (Reutilizable) o **Ephemeral** (Efímera) para que, al destruir y volver a construir
   tu contenedor Doodba, el registro de la máquina en Tailscale se maneje sin problemas.
4. Copia la clave generada y reemplaza `tskey-auth-your-key-here` en tu configuración de
   `docker-compose.yml`.

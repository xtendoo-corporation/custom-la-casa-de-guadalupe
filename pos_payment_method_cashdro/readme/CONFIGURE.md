To add a Cashdro payment terminal:

1.  Go to _Point of Sale \> Configuration \> Payment Methods_
2.  Choose a cash payment method or create a new one.
3.  Select _Cashdro_ in the _Use a Payment Terminal_ field.
4.  Configure the Cashdro terminal hostname and credentials.
5.  Configure the desired, Cashdro terminal in the proper PoS configurations.

Note that if a single payment method was used for cash in different stores, it should be
splitted in as many physical stores there are.

## Network Requirements (Odoo Cloud to Local CashDro)

When Odoo is hosted in the Cloud and the CashDro device is located in the store's local
network (LAN, e.g., `192.168.1.x`), a secure tunnel or VPN **must be established**.
Otherwise, Odoo will fail to connect due to timeouts.

We recommend using **Tailscale** for a quick Subnet Routing setup:

1. Install Tailscale on the Odoo Cloud server
   (`curl -fsSL https://tailscale.com/install.sh | sh`).
2. Install Tailscale on the Windows POS PC in the physical store.
3. On the Windows POS PC, open **CMD or PowerShell as Administrator** and advertise the
   store's local subnet: `tailscale up --advertise-routes=192.168.1.0/24` _(change to
   your actual subnet)_.
4. On the Tailscale web admin console, go to the Windows Machine settings and
   **Approve** the subnet route.
5. In Odoo Payment Method configuration, keep the actual LAN IP of the CashDro (e.g.
   `192.168.1.50`). The Odoo server will now successfully reach it through the Tailscale
   tunnel.

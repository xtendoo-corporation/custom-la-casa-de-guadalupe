"""
Proxy controller – routes CashDro HTTP traffic through the Odoo backend.

Problem
-------
Odoo is served over HTTPS.  The CashDro device speaks HTTP (or HTTPS with
a self-signed certificate) on the store's LAN.  Browsers block these
requests as "mixed content" → ``ERR_CERT_AUTHORITY_INVALID`` / ``Failed to
fetch``.

Solution
--------
The POS JavaScript calls ``/cashdro/proxy`` on the *same* Odoo origin
(HTTPS → HTTPS, no mixed-content).  This controller forwards the request
to the CashDro over HTTP/HTTPS with ``verify=False`` (the CashDro manual
v4.14 §3.1.1 explicitly recommends disabling SSL verification for its
self-signed certificates).

Network requirement
-------------------
The machine running Odoo (or its Docker container) **must** be able to
reach the CashDro IP on the LAN.  In Docker you may need
``extra_hosts: ["host.docker.internal:host-gateway"]`` and proper routing,
or ``network_mode: host``.
"""

import logging
import urllib3

import requests
from urllib.parse import urlparse

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

# Suppress only the InsecureRequestWarning from urllib3 (CashDro uses
# self-signed certs – the official manual says to skip verification).
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Generous timeouts – the CashDro Model S has a single-threaded HTTP
# server and can be very slow when busy counting coins/bills.
CASHDRO_CONNECT_TIMEOUT = 15   # seconds
CASHDRO_READ_TIMEOUT = 30      # seconds


class CashdroProxyController(http.Controller):

    @http.route("/cashdro/proxy", type="jsonrpc", auth="user", methods=["POST"])
    def cashdro_proxy(self, cashdro_url=None, **kwargs):
        """Forward a GET request to the CashDro device and return its JSON
        response.

        :param str cashdro_url: Full URL to call on the CashDro device,
            e.g. ``http://192.168.1.137/Cashdro3WS/index.php?name=...``
        :returns: dict with ``ok`` (bool), ``data`` (CashDro JSON or None),
            ``error`` (str or None)
        """
        if not cashdro_url:
            return {"ok": False, "data": None, "error": "cashdro_url is required"}

        # Security: only allow calls to hosts configured in payment methods.
        if not self._is_allowed_host(cashdro_url):
            _logger.warning(
                "CashDro proxy: blocked request to non-configured host: %s",
                cashdro_url,
            )
            return {
                "ok": False,
                "data": None,
                "error": "Host not allowed. Configure it in the payment method.",
            }

        try:
            _logger.info("CashDro proxy → %s", cashdro_url)
            resp = requests.get(
                cashdro_url,
                timeout=(CASHDRO_CONNECT_TIMEOUT, CASHDRO_READ_TIMEOUT),
                # CashDro uses self-signed SSL certs – manual §3.1.1 says
                # to skip verification.
                verify=False,
            )
            resp.raise_for_status()
            data = resp.json()
            _logger.info("CashDro proxy ← %s", data)
            return {"ok": True, "data": data, "error": None}
        except requests.exceptions.ConnectTimeout:
            msg = (
                f"Connection to CashDro timed out ({CASHDRO_CONNECT_TIMEOUT}s). "
                "Check that the Odoo server can reach the CashDro IP."
            )
            _logger.error("CashDro proxy: %s – URL: %s", msg, cashdro_url)
            return {"ok": False, "data": None, "error": msg}
        except requests.exceptions.ConnectionError as exc:
            msg = f"Cannot connect to CashDro: {exc}"
            _logger.error("CashDro proxy: %s", msg)
            return {"ok": False, "data": None, "error": msg}
        except requests.exceptions.ReadTimeout:
            msg = f"CashDro did not respond within {CASHDRO_READ_TIMEOUT}s."
            _logger.error("CashDro proxy: %s", msg)
            return {"ok": False, "data": None, "error": msg}
        except requests.exceptions.HTTPError as exc:
            msg = f"CashDro HTTP error: {exc.response.status_code} – {exc}"
            _logger.error("CashDro proxy: %s", msg)
            return {"ok": False, "data": None, "error": msg}
        except Exception as exc:
            msg = f"CashDro proxy unexpected error: {exc}"
            _logger.exception(msg)
            return {"ok": False, "data": None, "error": msg}

    def _is_allowed_host(self, url):
        """Check that the target URL belongs to a configured CashDro host."""
        parsed = urlparse(url)
        target = f"{parsed.scheme}://{parsed.hostname}"
        if parsed.port and parsed.port not in (80, 443):
            target += f":{parsed.port}"

        # Search all CashDro payment methods
        methods = (
            request.env["pos.payment.method"]
            .sudo()
            .search([("use_payment_terminal", "=", "cashdro")])
        )
        for m in methods:
            if not m.cashdro_host:
                continue
            host = m.cashdro_host.rstrip("/")
            # Normalise: add http:// if missing
            if not host.startswith("http"):
                host = f"http://{host}"
            host_parsed = urlparse(host)
            allowed = f"{host_parsed.scheme}://{host_parsed.hostname}"
            if host_parsed.port and host_parsed.port not in (80, 443):
                allowed += f":{host_parsed.port}"
            if target == allowed:
                return True
        return False



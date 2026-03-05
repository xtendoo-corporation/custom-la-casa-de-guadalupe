import json
import time
import threading
from urllib.parse import unquote
from http.server import BaseHTTPRequestHandler, HTTPServer

# Server configurations
HOST_NAME = "0.0.0.0"
PORT_NUMBER = 8080

# State management
STATE_IDLE = "I"
STATE_PROCESSING = "Q"
STATE_FINISHED = "F"
STATE_ERROR = "E"

# Store the pseudo-state of the mock cashdro
cashdro_state = {
    "current_operation_id": None,
    "status": STATE_IDLE,
    "amount_requested": 0,
    "amount_received": 0,
    "aliasid": None,
    "error_mode": False,
    "busy_mode": False,
}


class CashdroHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global cashdro_state

        self.send_response(200)
        self.send_header("Content-type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        # Parse query parameters manually
        path_parts = self.path.split("?")
        params = {}
        if len(path_parts) > 1:
            for pair in path_parts[1].split("&"):
                kv = pair.split("=")
                if len(kv) == 2:
                    params[kv[0]] = unquote(kv[1])

        operation = params.get("operation", "")

        response_data = None

        if operation == "startOperation":
            print(f"[{time.strftime('%H:%M:%S')}] Received startOperation")

            if cashdro_state["busy_mode"]:
                # Simulate -3 system busy
                response_data = '{"code": -3, "message": "System busy"}'
            else:
                aliasid = params.get("aliasid")
                # Idempotency check
                if (
                    aliasid
                    and aliasid == cashdro_state["aliasid"]
                    and cashdro_state["status"] != STATE_IDLE
                ):
                    print(
                        f"[{time.strftime('%H:%M:%S')}] Duplicate startOperation detected (aliasid={aliasid}). Returning existing operationId."
                    )
                    response_data = cashdro_state["current_operation_id"]
                else:
                    try:
                        param_obj = json.loads(params.get("parameters", "{}"))
                        amount = param_obj.get("amount", 0)
                    except:
                        amount = 0

                    op_id = f"MOCKOP-{int(time.time())}"

                    cashdro_state["current_operation_id"] = op_id
                    cashdro_state["status"] = STATE_PROCESSING
                    cashdro_state["amount_requested"] = amount
                    cashdro_state["amount_received"] = 0
                    cashdro_state["aliasid"] = aliasid

                    response_data = op_id

                    # Auto-complete the operation after 15 seconds in background if not in error mode
                    if not cashdro_state["error_mode"]:
                        threading.Thread(
                            target=self.auto_complete_operation, args=(amount,)
                        ).start()

        elif operation == "acknowledgeOperationId":
            print(f"[{time.strftime('%H:%M:%S')}] Received acknowledgeOperationId")
            response_data = "1"

        elif operation == "askOperation":
            op_id = params.get("operationId")
            print(f"[{time.strftime('%H:%M:%S')}] Received askOperation for {op_id}")

            if cashdro_state["current_operation_id"] == op_id:
                # Build typical response JSON
                response_data = json.dumps(
                    {
                        "code": 1,
                        "operation": {
                            "state": cashdro_state["status"],
                            "totalout": 0,
                            "totalin": cashdro_state["amount_received"],
                        },
                    }
                )
            else:
                response_data = json.dumps(
                    {"code": -1, "message": "Operation not found"}
                )

        elif operation == "finishOperation":
            print(f"[{time.strftime('%H:%M:%S')}] Received finishOperation (Cancel)")
            cashdro_state["status"] = STATE_FINISHED
            # If we cancel, amount received might be 0 or partial
            cashdro_state["amount_received"] = 0
            response_data = "1"

        else:
            response_data = json.dumps({"code": -99, "message": "Unknown operation"})

        # Send response body
        if response_data:
            self.wfile.write(bytes(response_data, "utf-8"))

    def auto_complete_operation(self, amount):
        global cashdro_state
        print(
            f"[{time.strftime('%H:%M:%S')}] Mock Cashdro: User inserting coins... Waiting 15s"
        )
        time.sleep(15)
        if cashdro_state["status"] == STATE_PROCESSING:
            print(
                f"[{time.strftime('%H:%M:%S')}] Mock Cashdro: Target money completed."
            )
            cashdro_state["status"] = STATE_FINISHED
            cashdro_state["amount_received"] = amount


if __name__ == "__main__":
    server_class = HTTPServer
    httpd = server_class((HOST_NAME, PORT_NUMBER), CashdroHandler)
    print(
        time.asctime(), "Mock CashDro Server Starts - %s:%s" % (HOST_NAME, PORT_NUMBER)
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    print(
        time.asctime(), "Mock CashDro Server Stops - %s:%s" % (HOST_NAME, PORT_NUMBER)
    )

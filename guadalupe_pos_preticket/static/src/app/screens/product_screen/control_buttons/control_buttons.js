import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { useAsyncLockedMethod } from "@point_of_sale/app/hooks/hooks";
import { patch } from "@web/core/utils/patch";

patch(ControlButtons.prototype, {
    setup() {
        super.setup(...arguments);
        this.clickPrintPreticket = useAsyncLockedMethod(this.clickPrintPreticket);
    },
    async clickPrintPreticket() {
        // amount_total / price_subtotal_incl are plain fields only filled in
        // by setOrderPrices(), normally called just before syncing the order
        // to the backend (see PosStore.preSyncAllOrders). The preticket never
        // syncs, so without this call every price and the total would print
        // as 0.00 even though the order already has lines.
        this.currentOrder.setOrderPrices();
        await this.pos.printReceipt({
            printBillActionTriggered: true,
        });
    },
});

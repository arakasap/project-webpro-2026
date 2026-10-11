const NON_BILLABLE_ORDER_STATUSES = new Set(['cancelled', 'pending']);

const BILLABLE_ORDER_ITEM_SQL =
    "LOWER(TRIM(COALESCE(oi.status, ''))) NOT IN ('cancelled', 'pending')";

function isBillableOrderItem(item) {
    return !NON_BILLABLE_ORDER_STATUSES.has(String(item.status || '').trim().toLowerCase());
}

module.exports = {
    BILLABLE_ORDER_ITEM_SQL,
    isBillableOrderItem
};

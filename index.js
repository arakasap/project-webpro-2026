const express = require('express');
const session = require('express-session');
const QRCode = require('qrcode');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { EventEmitter } = require('events');
const createCustomerRouter = require('./routes/customer');
const createCashierRouter = require('./routes/cashier');
const createKitchenRouter = require('./routes/kitchen');

const app = express();
const orderUpdates = new EventEmitter();
orderUpdates.setMaxListeners(0);
const PORT = process.env.PORT || 3000;

function notifyOrderUpdate(sessionId) {
    if (sessionId != null) orderUpdates.emit('order-updated', String(sessionId));
    orderUpdates.emit('system-updated');
}

// -----------------------------------------------------------------------------
// 1. Session cart helpers
// -----------------------------------------------------------------------------
function buildSessionCartKey(sessionId, userId) {
    return `cart:${String(sessionId)}:${String(userId)}`;
}

function getSessionCartStore(sessionState) {
    if (!sessionState) return null;
    return (sessionState.cart && typeof sessionState.cart === 'object') ? sessionState.cart : sessionState;
}

function getSessionCartState(req, sessionId, userId) {
    if (!req.session) {
        throw new Error('Session middleware is not initialized.');
    }

    if (!req.session.cart) {
        req.session.cart = {};
    }

    const key = buildSessionCartKey(sessionId, userId);
    if (!req.session.cart[key]) {
        req.session.cart[key] = { items: [] };
    }

    return req.session.cart[key];
}

function addSessionCartItem(sessionState, cartKey, item) {
    const cartStore = getSessionCartStore(sessionState);
    if (!cartStore) return false;
    if (!cartStore[cartKey]) {
        cartStore[cartKey] = { items: [] };
    }

    cartStore[cartKey].items.push({
        ...item,
        qty: Number(item.qty) || 1,
        menu_item_id: String(item.menu_item_id),
        note: String(item.note || ''),
        shared_user_ids: Array.isArray(item.shared_user_ids)
            ? item.shared_user_ids.map(String)
            : (item.shared_user_ids ? [String(item.shared_user_ids)] : [])
    });

    return true;
}

function removeSessionCartItem(sessionState, cartKey, targetId) {
    const cartStore = getSessionCartStore(sessionState);
    if (!cartStore || !cartStore[cartKey]) return false;

    const before = cartStore[cartKey].items.length;
    cartStore[cartKey].items = cartStore[cartKey].items.filter((item) => {
        const currentId = String(item.temp_id || item.menu_item_id || item.id || '');
        return currentId !== String(targetId);
    });

    return before !== cartStore[cartKey].items.length;
}

function getSessionCartSnapshot(sessionState, sessionId, userId) {
    const cartStore = getSessionCartStore(sessionState);
    const key = buildSessionCartKey(sessionId, userId);
    const cart = cartStore && cartStore[key] ? cartStore[key] : { items: [] };

    return {
        items: (cart.items || []).map((item, index) => ({
            ...item,
            temp_id: item.temp_id || `temp-${index}-${String(item.menu_item_id || 'item')}`,
            qty: Number(item.qty) || 1,
            title: item.title || item.name || 'เมนู',
            name: item.name || item.title || 'เมนู',
            shared_user_ids: Array.isArray(item.shared_user_ids)
                ? item.shared_user_ids.map(String)
                : (item.shared_user_ids ? [String(item.shared_user_ids)] : [])
        }))
    };
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middlewares
app.use(session({
    secret: 'restaurant-ordering-system-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax'
    }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('DB Error:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        // เปิดใช้งาน Foreign Keys Constraint ใน SQLite
        db.run('PRAGMA foreign_keys = ON;');
    }
});

// Settings
const PROMPTPAY_NO = '0997072467';

const createTablesRouter = require('./routes/tables');

// Feature routes
app.use(createTablesRouter({ db }));
app.use(createCustomerRouter({
    db,
    events: orderUpdates,
    notifyOrderUpdate,
    cartHelpers: {
        buildSessionCartKey,
        getSessionCartStore,
        getSessionCartState,
        addSessionCartItem,
        removeSessionCartItem,
        getSessionCartSnapshot
    }
}));
app.use(createCashierRouter({ db, promptpayNo: PROMPTPAY_NO, notifyOrderUpdate }));
app.use(createKitchenRouter({ db, notifyOrderUpdate }));

// Start Server
// -----------------------------------------------------------------------------
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
}
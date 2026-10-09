const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
const PROMPTPAY_NO = '0812345678'; // หมายเลข PromptPay ร้านค้า

// -----------------------------------------------------------------------------
// 1. หน้าต้อนรับ
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
    const sessionId = req.query.session_id || 1;

    db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [sessionId], (err, existingUsers) => {
        if (err) existingUsers = [];

        db.get(`
            SELECT name, image_url
            FROM MENU_ITEMS
            WHERE is_available = 1 AND image_url IS NOT NULL AND TRIM(image_url) != ''
            ORDER BY menu_item_id
            LIMIT 1
        `, [], (menuErr, featuredItem) => {
            if (menuErr) featuredItem = null;

            res.render('index', {
                sessionId: sessionId,
                shopName: "ไอทีม่วนแจ่ม",
                featuredItem: featuredItem,
                existingUsers: existingUsers,
                instructions: [
                    "ใส่ชื่อเล่นของคุณและเริ่มสั่งอาหาร",
                    "เพิ่มรายการได้ทุกเมื่อ",
                    "แยกจ่ายเงินและจ่ายตามที่คุณต้องการ"
                ]
            });
        });
    });
});

app.post('/join-session', (req, res) => {
    const { session_id, table_id, name } = req.body;
    if (!name || name.trim() === '') {
        return res.send('<script>alert("กรุณากรอกชื่อเล่น"); window.history.back();</script>');
    }

    const targetTableId = table_id || session_id || 1;
    const ensureTableSql = `INSERT OR IGNORE INTO TABLES (table_id, table_number, status) VALUES (?, ?, 'AVAILABLE')`;

    db.run(ensureTableSql, [targetTableId, String(targetTableId)], (err) => {
        if (err) console.log('Ensure table notice:', err.message);

        db.get('SELECT session_id FROM SESSIONS WHERE table_id = ? AND LOWER(status) = "active"', [targetTableId], (err, activeSession) => {
            if (err) {
                console.error('Error checking active session:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบ Session');
            }

            const saveUserAndRedirect = (sessionIdToUse) => {
                const sqlUser = `INSERT INTO SESSION_USERS (session_id, name, is_paid) VALUES (?, ?, 0)`;
                db.run(sqlUser, [sessionIdToUse, name.trim()], function (err) {
                    if (err) {
                        console.error('Error saving user:', err.message);
                        return res.status(500).send('เกิดข้อผิดพลาดในการบันทึกข้อมูลผู้ใช้');
                    }
                    res.redirect(`/menu?session_id=${sessionIdToUse}&user_id=${this.lastID}`);
                });
            };

            if (activeSession) {
                saveUserAndRedirect(activeSession.session_id);
            } else {
                const createSessionSql = `INSERT INTO SESSIONS (table_id, status) VALUES (?, 'active')`;
                db.run(createSessionSql, [targetTableId], function (err) {
                    if (err) {
                        console.error('Error creating new session:', err.message);
                        return res.status(500).send('เกิดข้อผิดพลาดในการสร้าง Session ใหม่: ' + err.message);
                    }
                    saveUserAndRedirect(this.lastID);
                });
            }
        });
    });
});

// -----------------------------------------------------------------------------
// 2. หน้าแสดงรายการอาหาร (Menu Page)
// -----------------------------------------------------------------------------
app.get('/menu', (req, res) => {
    const { session_id, user_id } = req.query;

    if (!session_id || !user_id) {
        return res.redirect('/');
    }

    db.get('SELECT * FROM SESSION_USERS WHERE user_id = ?', [user_id], (err, user) => {
        if (err || !user) return res.status(400).send('ไม่พบข้อมูลผู้ใช้งาน');

        if (String(user.session_id) !== String(session_id)) {
            return res.status(400).send('ผู้ใช้ไม่ได้อยู่ในโต๊ะนี้');
        }

        db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [session_id], (err, sessionUsers) => {
            if (err) sessionUsers = [];

            db.all('SELECT * FROM CATEGORIES', [], (err, categories) => {
                if (err) categories = [];

                db.all('SELECT * FROM MENU_ITEMS WHERE is_available = 1', [], (err, menuItems) => {
                    if (err) menuItems = [];

                    res.render('menu', {
                        user: user,
                        sessionUsers: sessionUsers,
                        categories: categories,
                        menuItems: menuItems,
                        sessionId: session_id,
                        userId: user_id
                    });
                });
            });
        });
    });
});

// -----------------------------------------------------------------------------
// Customer order status
// -----------------------------------------------------------------------------
app.get('/order-status', (req, res) => {
    const { session_id, user_id } = req.query;
    if (!session_id) return res.redirect('/');

    const findSession = (callback) => {
        db.get('SELECT session_id, table_id FROM SESSIONS WHERE session_id = ?', [session_id], (err, sessionRow) => {
            if (err) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบโต๊ะ');
            if (sessionRow) return callback(sessionRow);

            db.get(
                `SELECT session_id, table_id FROM SESSIONS
                 WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT) AND LOWER(status) = 'active'
                 ORDER BY session_id DESC LIMIT 1`,
                [session_id],
                (tableErr, activeSession) => {
                    if (tableErr) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบโต๊ะ');
                    callback(activeSession || null);
                }
            );
        });

        // Read-only summary of all saved food items for the customer's table session
        app.get('/table-summary', (req, res) => {
            const sessionId = String(req.query.session_id || '');
            const userId = String(req.query.user_id || '');
            if (!sessionId || !userId) return res.redirect('/');

            db.get('SELECT user_id, name FROM SESSION_USERS WHERE user_id = ? AND session_id = ?', [userId, sessionId], (userErr, user) => {
                if (userErr) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบผู้ใช้');
                if (!user) return res.status(400).send('ไม่พบผู้ใช้ในโต๊ะนี้');

                const sql = `
                    SELECT oi.order_item_id, oi.qty, oi.note, oi.status, oi.cancel_reason,
                           mi.name, mi.price, mi.image_url,
                           GROUP_CONCAT(DISTINCT su.name) AS owner_names
                    FROM ORDER_ITEMS oi
                    JOIN ORDERS o ON o.order_id = oi.order_id
                    JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
                    LEFT JOIN ORDER_ITEM_OWNERS oio ON oio.order_item_id = oi.order_item_id
                    LEFT JOIN SESSION_USERS su ON su.user_id = oio.user_id
                    WHERE o.session_id = ?
                    GROUP BY oi.order_item_id
                    ORDER BY oi.order_item_id DESC
                `;

                db.all(sql, [sessionId], (itemsErr, items) => {
                    if (itemsErr) {
                        console.error('Error fetching table order summary:', itemsErr.message);
                        return res.status(500).send('เกิดข้อผิดพลาดในการดึงรายการอาหาร');
                    }

                    db.get(`
                        SELECT t.table_number
                        FROM SESSIONS s
                        JOIN TABLES t ON t.table_id = s.table_id
                        WHERE s.session_id = ?
                    `, [sessionId], (tableErr, table) => {
                        const tableItems = items || [];
                        const tableTotal = tableItems.reduce((sum, item) => {
                            if (String(item.status).toLowerCase() === 'cancelled') return sum;
                            return sum + (Number(item.price) || 0) * (Number(item.qty) || 0);
                        }, 0);

                        res.render('table-summary', {
                            user,
                            sessionId,
                            tableNo: table && table.table_number ? table.table_number : sessionId,
                            items: tableItems,
                            tableTotal
                        });
                    });
                });
            });
        });
    };

    findSession((sessionRow) => {
        if (!sessionRow) {
            return res.render('order-status', {
                sessionId: session_id,
                userId: user_id || '',
                tableNo: session_id,
                items: [],
                updatedAt: new Date()
            });
        }

        const loadItems = (currentUser) => {
            const sql = `
                  SELECT oi.order_item_id, oi.qty, oi.note, oi.status, oi.cancel_reason,
                      mi.name, mi.price, mi.image_url,
                      GROUP_CONCAT(DISTINCT oio.user_id) AS owner_ids,
                      GROUP_CONCAT(DISTINCT su.name) AS owner_names
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON o.order_id = oi.order_id
                JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
                LEFT JOIN ORDER_ITEM_OWNERS oio ON oio.order_item_id = oi.order_item_id
                LEFT JOIN SESSION_USERS su ON su.user_id = oio.user_id
                WHERE o.session_id = ?
                GROUP BY oi.order_item_id
                ORDER BY CASE LOWER(TRIM(oi.status))
                    WHEN 'pending' THEN 1
                    WHEN 'ordered' THEN 2
                    WHEN 'cooking' THEN 3
                    WHEN 'ready' THEN 4
                    WHEN 'served' THEN 5
                    WHEN 'cancelled' THEN 6
                    ELSE 7
                END, oi.order_item_id DESC
            `;

            db.all(sql, [sessionRow.session_id], (err, items) => {
                if (err) {
                    console.error('Error fetching customer order status:', err.message);
                    return res.status(500).send('เกิดข้อผิดพลาดในการดึงสถานะออร์เดอร์');
                }

                db.get('SELECT table_number FROM TABLES WHERE table_id = ?', [sessionRow.table_id], (tableErr, table) => {
                    db.all('SELECT user_id, name FROM SESSION_USERS WHERE session_id = ? ORDER BY user_id', [sessionRow.session_id], (usersErr, sessionUsers) => {
                        res.render('order-status', {
                            sessionId: sessionRow.session_id,
                            userId: currentUser ? currentUser.user_id : '',
                            tableNo: table && table.table_number ? table.table_number : sessionRow.table_id,
                            sessionUsers: sessionUsers || [],
                            items: items || [],
                            updatedAt: new Date()
                        });
                    });
                });
            });
        };

        if (!user_id) return loadItems(null);
        db.get('SELECT user_id, name FROM SESSION_USERS WHERE user_id = ? AND session_id = ?', [user_id, sessionRow.session_id], (err, currentUser) => {
            if (err) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบผู้ใช้');
            if (!currentUser) return res.status(400).send('ไม่พบผู้ใช้ในโต๊ะนี้');
            loadItems(currentUser);
        });
    });
});

// Read-only customer table order summary
app.get('/table-summary', (req, res) => {
    const sessionId = String(req.query.session_id || '');
    const userId = String(req.query.user_id || '');
    if (!sessionId || !userId) return res.redirect('/');

    db.get(
        'SELECT user_id, name FROM SESSION_USERS WHERE user_id = ? AND session_id = ?',
        [userId, sessionId],
        (userErr, user) => {
            if (userErr) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบผู้ใช้');
            if (!user) return res.status(400).send('ไม่พบผู้ใช้ในโต๊ะนี้');

            const sql = `
                SELECT oi.order_item_id, oi.qty, oi.status, mi.name, mi.price,
                       GROUP_CONCAT(DISTINCT oio.user_id) AS owner_ids
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON o.order_id = oi.order_id
                JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
                LEFT JOIN ORDER_ITEM_OWNERS oio ON oio.order_item_id = oi.order_item_id
                WHERE o.session_id = ?
                GROUP BY oi.order_item_id
                ORDER BY oi.order_item_id DESC
            `;

            db.all(sql, [sessionId], (itemsErr, items) => {
                if (itemsErr) {
                    console.error('Error fetching table order summary:', itemsErr.message);
                    return res.status(500).send('เกิดข้อผิดพลาดในการดึงรายการอาหาร');
                }

                db.get(
                    `SELECT t.table_number
                     FROM SESSIONS s JOIN TABLES t ON t.table_id = s.table_id
                     WHERE s.session_id = ?`,
                    [sessionId],
                    (tableErr, table) => {
                        if (tableErr) {
                            console.error('Error fetching table number for summary:', tableErr.message);
                            return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบโต๊ะ');
                        }

                        const normalizedItems = (items || []).map((item) => {
                            return {
                                ...item,
                                owner_ids: String(item.owner_ids || '')
                                    .split(',')
                                    .map((ownerId) => String(ownerId).trim())
                                    .filter(Boolean)
                            };
                        });

                        const tableTotal = normalizedItems.reduce((total, item) => {
                            if (String(item.status).toLowerCase() === 'cancelled') return total;
                            return total + (Number(item.price) || 0) * (Number(item.qty) || 0);
                        }, 0);

                        db.all('SELECT user_id, name FROM SESSION_USERS WHERE session_id = ? ORDER BY user_id', [sessionId], (usersErr, sessionUsers) => {
                            if (usersErr) {
                                console.error('Error fetching table summary members:', usersErr.message);
                                return res.status(500).send('เกิดข้อผิดพลาดในการดึงรายชื่อสมาชิกโต๊ะ');
                            }

                            const payerDetails = new Map();
                            (sessionUsers || []).forEach((member) => {
                                payerDetails.set(String(member.user_id), {
                                    name: member.name,
                                    total: 0,
                                    items: []
                                });
                            });

                            normalizedItems.forEach((item) => {
                                if (String(item.status || '').toLowerCase() === 'cancelled') return;

                                const payerIds = item.owner_ids.length
                                    ? item.owner_ids.filter((ownerId) => payerDetails.has(ownerId))
                                    : [...payerDetails.keys()];
                                if (!payerIds.length) return;

                                const itemTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
                                const perPerson = itemTotal / payerIds.length;
                                payerIds.forEach((payerId) => {
                                    const payer = payerDetails.get(payerId);
                                    payer.total += perPerson;
                                    payer.items.push({
                                        name: item.name,
                                        qty: Number(item.qty) || 0,
                                        share: perPerson
                                    });
                                });
                            });

                            const splitDetails = [...payerDetails.values()];

                            res.render('table-summary', {
                                sessionId,
                                user,
                                tableNo: table && table.table_number ? table.table_number : sessionId,
                                items: normalizedItems,
                                tableTotal,
                                splitDetails,
                                sessionUsers: sessionUsers || []
                            });
                        });
                    }
                );
            });
        }
    );
});

app.get('/owner-summary', (req, res) => {
    const sessionId = String(req.query.session_id || '');
    const userId = String(req.query.user_id || '');

    if (!sessionId || !userId) return res.redirect('/');

    db.get(
        'SELECT user_id, name FROM SESSION_USERS WHERE user_id = ? AND session_id = ?',
        [userId, sessionId],
        (userErr, user) => {
            if (userErr) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบผู้ใช้');
            if (!user) return res.status(400).send('ไม่พบผู้ใช้ในโต๊ะนี้');

            db.get(
                `SELECT t.table_number
                 FROM SESSIONS s
                 JOIN TABLES t ON t.table_id = s.table_id
                 WHERE s.session_id = ?`,
                [sessionId],
                (tableErr, table) => {
                    if (tableErr) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบโต๊ะ');

                    db.all(
                        `SELECT user_id, name
                         FROM SESSION_USERS
                         WHERE session_id = ?
                         ORDER BY user_id`,
                        [sessionId],
                        (membersErr, sessionUsers) => {
                            if (membersErr) {
                                console.error('Error fetching session members:', membersErr.message);
                                return res.status(500).send('เกิดข้อผิดพลาดในการดึงรายชื่อสมาชิกโต๊ะ');
                            }

                            db.all(
                                `SELECT oi.order_item_id, oi.qty, oi.status, oi.note,
                                        mi.name AS item_name, mi.price, mi.image_url,
                                        su.user_id AS owner_id, su.name AS owner_name
                                 FROM ORDER_ITEMS oi
                                 JOIN ORDERS o ON o.order_id = oi.order_id
                                 JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
                                 LEFT JOIN ORDER_ITEM_OWNERS oio ON oio.order_item_id = oi.order_item_id
                                 LEFT JOIN SESSION_USERS su ON su.user_id = oio.user_id AND su.session_id = o.session_id
                                 WHERE o.session_id = ? AND LOWER(COALESCE(oi.status, '')) != 'cancelled'
                                 ORDER BY oi.order_item_id DESC, oio.user_id`,
                                [sessionId],
                                (itemsErr, itemRows) => {
                                    if (itemsErr) {
                                        console.error('Error fetching owner summary items:', itemsErr.message);
                                        return res.status(500).send('เกิดข้อผิดพลาดในการดึงรายการอาหาร');
                                    }

                                    const itemsById = new Map();
                                    (itemRows || []).forEach((row) => {
                                        let item = itemsById.get(row.order_item_id);
                                        if (!item) {
                                            item = {
                                                order_item_id: row.order_item_id,
                                                qty: Number(row.qty || 0),
                                                status: row.status,
                                                note: row.note,
                                                item_name: row.item_name,
                                                price: Number(row.price || 0),
                                                image_url: row.image_url,
                                                owner_ids: [],
                                                owner_names: []
                                            };
                                            itemsById.set(row.order_item_id, item);
                                        }

                                        if (row.owner_id) {
                                            item.owner_ids.push(String(row.owner_id));
                                            if (row.owner_name) item.owner_names.push(row.owner_name);
                                        }
                                    });

                                    const items = [...itemsById.values()].map((item) => ({
                                        ...item,
                                        line_total: item.price * item.qty,
                                        owner_ids: item.owner_ids.length
                                            ? item.owner_ids
                                            : sessionUsers.map((member) => String(member.user_id)),
                                        owner_names: item.owner_names.length
                                            ? item.owner_names
                                            : sessionUsers.map((member) => member.name)
                                    }));
                                    const currentUserId = String(user.user_id);
                                    const userTotal = items.reduce((total, item) => {
                                        if (!item.owner_ids.includes(currentUserId)) return total;
                                        return total + item.line_total / item.owner_ids.length;
                                    }, 0);

                                    res.render('owner-summary', {
                                        sessionId,
                                        user,
                                        tableNo: table && table.table_number ? table.table_number : sessionId,
                                        sessionUsers,
                                        items,
                                        userTotal
                                    });
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

app.post('/api/order-items/:id/owners', (req, res) => {
    const orderItemId = Number(req.params.id);
    const sessionId = String(req.body.session_id || '');
    const userId = String(req.body.user_id || '');
    const ownerIds = [...new Set((Array.isArray(req.body.owner_ids) ? req.body.owner_ids : []).map(String).filter(Boolean))];

    if (!Number.isInteger(orderItemId) || orderItemId <= 0 || !sessionId || !userId || ownerIds.length === 0) {
        return res.status(400).json({ success: false, message: 'ข้อมูลผู้รับผิดชอบไม่ครบถ้วน' });
    }

    db.get(`
        SELECT oi.order_item_id, oi.status
        FROM ORDER_ITEMS oi
        JOIN ORDERS o ON o.order_id = oi.order_id
        JOIN SESSION_USERS editor ON editor.session_id = o.session_id
        WHERE oi.order_item_id = ? AND o.session_id = ? AND editor.user_id = ?
    `, [orderItemId, sessionId, userId], (findErr, item) => {
        if (findErr) return res.status(500).json({ success: false, message: 'ตรวจสอบรายการไม่สำเร็จ' });
        if (!item) return res.status(404).json({ success: false, message: 'ไม่พบรายการหรือคุณไม่ได้เป็นสมาชิกโต๊ะนี้' });
        if (['served', 'cancelled'].includes(String(item.status).toLowerCase())) {
            return res.status(400).json({ success: false, message: 'รายการที่เสิร์ฟหรือยกเลิกแล้วแก้ผู้รับผิดชอบไม่ได้' });
        }

        const placeholders = ownerIds.map(() => '?').join(',');
        db.all(`SELECT user_id FROM SESSION_USERS WHERE session_id = ? AND user_id IN (${placeholders})`, [sessionId, ...ownerIds], (usersErr, users) => {
            if (usersErr) return res.status(500).json({ success: false, message: 'ตรวจสอบสมาชิกโต๊ะไม่สำเร็จ' });
            if ((users || []).length !== ownerIds.length) {
                return res.status(400).json({ success: false, message: 'เลือกได้เฉพาะสมาชิกในโต๊ะนี้' });
            }

            db.serialize(() => {
                db.run('BEGIN IMMEDIATE');
                db.run('DELETE FROM ORDER_ITEM_OWNERS WHERE order_item_id = ?', [orderItemId], (deleteErr) => {
                    if (deleteErr) {
                        return db.run('ROLLBACK', () => res.status(500).json({ success: false, message: 'บันทึกผู้รับผิดชอบไม่สำเร็จ' }));
                    }

                    const values = ownerIds.map(() => '(?, ?)').join(', ');
                    const params = ownerIds.flatMap((ownerId) => [orderItemId, ownerId]);
                    db.run(`INSERT INTO ORDER_ITEM_OWNERS (order_item_id, user_id) VALUES ${values}`, params, (insertErr) => {
                        if (insertErr) {
                            return db.run('ROLLBACK', () => res.status(500).json({ success: false, message: 'บันทึกผู้รับผิดชอบไม่สำเร็จ' }));
                        }
                        db.run('COMMIT', (commitErr) => {
                            if (commitErr) return res.status(500).json({ success: false, message: 'ยืนยันการบันทึกไม่สำเร็จ' });
                            res.json({ success: true });
                        });
                    });
                });
            });
        });
    });
});

// -----------------------------------------------------------------------------
// 3. รับฟอร์มเพิ่มรายการอาหารลงตะกร้าชั่วคราวใน session
// -----------------------------------------------------------------------------
app.post('/order/add', (req, res) => {
    const { session_id, user_id, menu_item_id, qty, note, shared_user_ids } = req.body;

    if (!session_id || !user_id || !menu_item_id) {
        return res.status(400).send('ข้อมูลไม่ครบถ้วน');
    }

    const ownersList = Array.isArray(shared_user_ids)
        ? shared_user_ids
        : (shared_user_ids ? [shared_user_ids] : [user_id]);

    db.get('SELECT menu_item_id, name, price, image_url FROM MENU_ITEMS WHERE menu_item_id = ?', [menu_item_id], (err, menuItem) => {
        if (err || !menuItem) {
            return res.status(400).send('ไม่พบเมนูที่เลือก');
        }

        const sessionCart = getSessionCartState(req, session_id, user_id);
        const itemEntry = {
            temp_id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            menu_item_id: String(menuItem.menu_item_id),
            name: menuItem.name,
            price: Number(menuItem.price) || 0,
            image_url: menuItem.image_url || '',
            qty: parseInt(qty) || 1,
            note: note || '',
            shared_user_ids: ownersList.map(String),
            user_id: String(user_id)
        };

        sessionCart.items.push(itemEntry);

        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('Error saving temp cart session:', saveErr.message);
                return res.status(500).send('ไม่สามารถบันทึกลงตะกร้าชั่วคราวได้');
            }

            res.redirect(`/menu?session_id=${session_id}&user_id=${user_id}`);
        });
    });
});

// API เพิ่มผู้ใช้งานใหม่ชั่วคราว
app.post('/api/add-user', (req, res) => {
    const { session_id, name } = req.body;
    if (!name || name.trim() === '') {
        return res.status(400).json({ error: 'กรุณากรอกชื่อเล่น' });
    }

    const sql = `INSERT INTO SESSION_USERS (session_id, name, is_paid) VALUES (?, ?, 0)`;
    db.run(sql, [session_id || 1, name.trim()], function (err) {
        if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });

        res.json({
            user_id: this.lastID,
            name: name.trim()
        });
    });
});

// -----------------------------------------------------------------------------
// 4. หน้าแสดงตะกร้าสินค้า
// -----------------------------------------------------------------------------
app.get('/cart', (req, res) => {
    const { session_id, user_id } = req.query;

    if (!session_id || !user_id) {
        return res.redirect('/');
    }

    db.get('SELECT * FROM SESSION_USERS WHERE user_id = ?', [user_id], (err, currentUser) => {
        if (err || !currentUser) return res.redirect('/');

        db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [session_id], (err, sessionUsers) => {
            if (err) sessionUsers = [];

            const tempCart = getSessionCartSnapshot(req.session, session_id, user_id);
            const tempCartItems = tempCart.items.map((item) => {
                const ownerIds = Array.isArray(item.shared_user_ids) ? item.shared_user_ids : [String(user_id)];
                const ownerNames = ownerIds.map((ownerId) => {
                    const match = sessionUsers && sessionUsers.find((u) => String(u.user_id) === String(ownerId));
                    return match ? match.name : ownerId;
                });
                const itemTotal = (Number(item.price) || 0) * (Number(item.qty) || 1);
                const shareCount = ownerIds.length || 1;
                const pricePerPerson = itemTotal / shareCount;
                const isMyItem = ownerIds.includes(String(user_id));

                return {
                    id: item.temp_id,
                    quantity: Number(item.qty) || 1,
                    note: item.note || '',
                    status: 'pending',
                    title: item.name || 'เมนู',
                    price: Number(item.price) || 0,
                    image: item.image_url || '/images/default-food.png',
                    owner_ids: ownerIds.join(','),
                    owner_names: ownerNames.join(', '),
                    ownerIds,
                    ownerNames: ownerNames.join(', '),
                    menu_item_id: item.menu_item_id,
                    shareCount,
                    pricePerPerson,
                    itemTotal,
                    isMyItem,
                    isTemp: true
                };
            });

            db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [session_id], (err, order) => {
                if (err || !order) {
                    const cartItems = [...tempCartItems];
                    let myTotalAmount = 0;
                    let tableTotalAmount = 0;
                    let myItemsCount = 0;

                    cartItems.forEach((item) => {
                        tableTotalAmount += item.itemTotal;
                        if (item.isMyItem) {
                            myTotalAmount += item.pricePerPerson;
                            myItemsCount += 1;
                        }
                    });

                    return res.render('cart', {
                        currentUser,
                        sessionUsers,
                        cartItems,
                        myTotalAmount,
                        tableTotalAmount,
                        myItemsCount,
                        tableNo: session_id,
                        sessionId: session_id,
                        userId: user_id
                    });
                }

                const query = `
                    SELECT 
                        oi.order_item_id AS id,
                        oi.menu_item_id,
                        oi.qty AS quantity,
                        oi.note,
                        oi.status,
                        mi.name AS title,
                        mi.price,
                        mi.image_url AS image,
                        GROUP_CONCAT(su.user_id) AS owner_ids,
                        GROUP_CONCAT(su.name) AS owner_names
                    FROM ORDER_ITEMS oi
                    JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                    LEFT JOIN ORDER_ITEM_OWNERS oio ON oi.order_item_id = oio.order_item_id
                    LEFT JOIN SESSION_USERS su ON oio.user_id = su.user_id
                    WHERE oi.order_id = ? AND oi.status = 'pending'
                    GROUP BY oi.order_item_id
                    ORDER BY oi.order_item_id DESC
                `;

                db.all(query, [order.order_id], (err, rawItems) => {
                    if (err) rawItems = [];

                    const dbCartItems = rawItems.map(item => {
                        const itemTotal = item.price * item.quantity;
                        const ownerIds = item.owner_ids ? item.owner_ids.split(',') : [];
                        const ownerNamesList = item.owner_names ? item.owner_names.split(',') : [];
                        const shareCount = ownerIds.length || 1;
                        const pricePerPerson = itemTotal / shareCount;
                        const isMyItem = ownerIds.includes(String(user_id));

                        return {
                            ...item,
                            itemTotal,
                            owner_ids: ownerIds.join(','),
                            ownerIds,
                            ownerNames: ownerNamesList.join(', '),
                            shareCount,
                            pricePerPerson,
                            isMyItem
                        };
                    });

                    const cartItems = [...dbCartItems, ...tempCartItems];
                    let myTotalAmount = 0;
                    let tableTotalAmount = 0;
                    let myItemsCount = 0;

                    cartItems.forEach((item) => {
                        const itemTotal = Number(item.itemTotal || 0);
                        tableTotalAmount += itemTotal;
                        if (item.isMyItem) {
                            myTotalAmount += Number(item.pricePerPerson || 0);
                            myItemsCount += 1;
                        }
                    });

                    res.render('cart', {
                        currentUser,
                        sessionUsers,
                        cartItems,
                        myTotalAmount,
                        tableTotalAmount,
                        myItemsCount,
                        tableNo: session_id,
                        sessionId: session_id,
                        userId: user_id
                    });
                });
            });
        });
    });
});

app.put('/api/cart/item/:id', (req, res) => {
    const itemId = String(req.params.id || '');
    const sessionId = String(req.body.session_id || '');
    const userId = String(req.body.user_id || '');
    const quantity = Number.parseInt(req.body.quantity, 10);
    const note = String(req.body.note || '').trim().slice(0, 200);
    const ownerIds = [...new Set((Array.isArray(req.body.owner_ids) ? req.body.owner_ids : []).map(String).filter(Boolean))];

    if (!sessionId || !userId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || ownerIds.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาตรวจสอบจำนวนและผู้รับผิดชอบ' });
    }

    const placeholders = ownerIds.map(() => '?').join(',');
    db.all(`SELECT user_id FROM SESSION_USERS WHERE session_id = ? AND user_id IN (${placeholders})`, [sessionId, ...ownerIds], (usersErr, users) => {
        if (usersErr) return res.status(500).json({ success: false, message: 'ตรวจสอบสมาชิกโต๊ะไม่สำเร็จ' });
        if ((users || []).length !== ownerIds.length) {
            return res.status(400).json({ success: false, message: 'เลือกได้เฉพาะสมาชิกในโต๊ะนี้' });
        }

        if (itemId.startsWith('temp-')) {
            const cartKey = buildSessionCartKey(sessionId, userId);
            const cart = req.session.cart && req.session.cart[cartKey];
            const item = cart && (cart.items || []).find((entry) => String(entry.temp_id || entry.id) === itemId);
            if (!item || !(item.shared_user_ids || []).map(String).includes(userId)) {
                return res.status(404).json({ success: false, message: 'ไม่พบรายการหรือคุณไม่มีสิทธิ์แก้ไข' });
            }

            item.qty = quantity;
            item.note = note;
            item.shared_user_ids = ownerIds;
            return req.session.save((saveErr) => {
                if (saveErr) return res.status(500).json({ success: false, message: 'บันทึกรายการไม่สำเร็จ' });
                res.json({ success: true });
            });
        }

        const orderItemId = Number(itemId);
        if (!Number.isInteger(orderItemId) || orderItemId <= 0) {
            return res.status(400).json({ success: false, message: 'รหัสรายการไม่ถูกต้อง' });
        }

        db.get(`
            SELECT oi.order_item_id
            FROM ORDER_ITEMS oi
            JOIN ORDERS o ON o.order_id = oi.order_id
            JOIN ORDER_ITEM_OWNERS current_owner ON current_owner.order_item_id = oi.order_item_id
            WHERE oi.order_item_id = ? AND o.session_id = ? AND oi.status = 'pending'
              AND current_owner.user_id = ?
        `, [orderItemId, sessionId, userId], (findErr, item) => {
            if (findErr) return res.status(500).json({ success: false, message: 'ตรวจสอบรายการไม่สำเร็จ' });
            if (!item) return res.status(404).json({ success: false, message: 'ไม่พบรายการที่แก้ไขได้' });

            db.serialize(() => {
                db.run('BEGIN IMMEDIATE');
                db.run('UPDATE ORDER_ITEMS SET qty = ?, note = ? WHERE order_item_id = ? AND status = \'pending\'', [quantity, note, orderItemId], (updateErr) => {
                    if (updateErr) {
                        return db.run('ROLLBACK', () => res.status(500).json({ success: false, message: 'บันทึกรายการไม่สำเร็จ' }));
                    }
                    db.run('DELETE FROM ORDER_ITEM_OWNERS WHERE order_item_id = ?', [orderItemId], (deleteErr) => {
                        if (deleteErr) {
                            return db.run('ROLLBACK', () => res.status(500).json({ success: false, message: 'บันทึกผู้รับผิดชอบไม่สำเร็จ' }));
                        }
                        const values = ownerIds.map(() => '(?, ?)').join(', ');
                        const params = ownerIds.flatMap((ownerId) => [orderItemId, ownerId]);
                        db.run(`INSERT INTO ORDER_ITEM_OWNERS (order_item_id, user_id) VALUES ${values}`, params, (insertErr) => {
                            if (insertErr) {
                                return db.run('ROLLBACK', () => res.status(500).json({ success: false, message: 'บันทึกผู้รับผิดชอบไม่สำเร็จ' }));
                            }
                            db.run('COMMIT', (commitErr) => {
                                if (commitErr) return res.status(500).json({ success: false, message: 'ยืนยันการบันทึกไม่สำเร็จ' });
                                res.json({ success: true });
                            });
                        });
                    });
                });
            });
        });
    });
});

// -----------------------------------------------------------------------------
// 5. ยืนยันออร์เดอร์จากตะกร้าชั่วคราว และบันทึกลง DB
// -----------------------------------------------------------------------------
app.post('/api/orders/confirm-from-session', (req, res) => {
    const { session_id, user_id } = req.body;

    if (!session_id || !user_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลโต๊ะและผู้ใช้ไม่ครบ' });
    }

    const sessionCart = getSessionCartState(req, session_id, user_id);
    const items = sessionCart.items || [];

    if (items.length === 0) {
        return res.json({ success: true, message: 'ไม่มีรายการชั่วคราวให้ยืนยัน', skipped: true });
    }

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [session_id], (err, order) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตรวจสอบออเดอร์' });
        }

        const insertItems = (orderId) => {
            const insertQueue = items.map((item) => new Promise((resolve, reject) => {
                const itemQty = Number(item.qty) || 1;
                const itemOwners = Array.isArray(item.shared_user_ids) && item.shared_user_ids.length > 0
                    ? item.shared_user_ids
                    : [user_id];

                db.run(
                    'INSERT INTO ORDER_ITEMS (order_id, menu_item_id, qty, note, status) VALUES (?, ?, ?, ?, "pending")',
                    [orderId, item.menu_item_id, itemQty, item.note || ''],
                    function (insertErr) {
                        if (insertErr) {
                            return reject(insertErr);
                        }

                        const orderItemId = this.lastID;
                        if (itemOwners.length === 0) {
                            return resolve();
                        }

                        const ownerPlaceholders = itemOwners.map(() => '(?, ?)').join(', ');
                        const ownerParams = [];
                        itemOwners.forEach((ownerId) => ownerParams.push(orderItemId, ownerId));

                        db.run(`INSERT INTO ORDER_ITEM_OWNERS (order_item_id, user_id) VALUES ${ownerPlaceholders}`, ownerParams, (ownerErr) => {
                            if (ownerErr) {
                                return reject(ownerErr);
                            }
                            resolve();
                        });
                    }
                );
            }));

            Promise.all(insertQueue)
                .then(() => {
                    sessionCart.items = [];
                    req.session.save((saveErr) => {
                        if (saveErr) {
                            console.error('Error clearing temp cart after confirm:', saveErr.message);
                        }
                        res.json({ success: true, message: 'บันทึกออเดอร์ลงฐานข้อมูลเรียบร้อยแล้ว' });
                    });
                })
                .catch((saveErr) => {
                    console.error('Error saving confirmed cart items:', saveErr.message);
                    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกออเดอร์' });
                });
        };

        if (!order) {
            db.run('INSERT INTO ORDERS (session_id, status) VALUES (?, "active")', [session_id], function (orderErr) {
                if (orderErr) {
                    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างออเดอร์' });
                }
                insertItems(this.lastID);
            });
        } else {
            insertItems(order.order_id);
        }
    });
});

// -----------------------------------------------------------------------------
// 5. API ยืนยันออร์เดอร์ส่งเข้าครัว (pending -> ordered)
// -----------------------------------------------------------------------------
app.post('/api/orders/send-to-kitchen', (req, res) => {
    const { tableNo, userId } = req.body;
    const sessionId = tableNo;

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [sessionId], (err, order) => {
        if (err || !order) {
            return res.status(400).json({ success: false, message: 'ไม่พบออเดอร์ที่เปิดใช้งานอยู่' });
        }

        const sqlUpdate = `
            UPDATE ORDER_ITEMS 
            SET status = 'ordered', sent_at = CURRENT_TIMESTAMP 
            WHERE order_id = ? 
              AND status = 'pending' 
              AND order_item_id IN (
                  SELECT order_item_id FROM ORDER_ITEM_OWNERS WHERE user_id = ?
              )
        `;

        db.run(sqlUpdate, [order.order_id, userId], function (err) {
            if (err) {
                console.error('Error updating status to kitchen:', err.message);
                return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการส่งเข้าครัว' });
            }

            if (this.changes === 0) {
                return res.status(400).json({ success: false, message: 'ไม่มีรายการอาหารใหม่ให้ส่งเข้าครัว' });
            }

            res.json({ success: true, message: 'ส่งออเดอร์เข้าครัวเรียบร้อยแล้ว', tableNo: sessionId });
        });
    });
});

// -----------------------------------------------------------------------------
// 6. ลบรายการอาหารในตะกร้า
// -----------------------------------------------------------------------------
app.delete('/api/cart/item/:id', (req, res) => {
    const itemId = req.params.id;

    if (String(itemId).startsWith('temp-')) {
        let removed = false;
        Object.keys(req.session.cart || {}).forEach((cartKey) => {
            const before = (req.session.cart[cartKey].items || []).length;
            req.session.cart[cartKey].items = (req.session.cart[cartKey].items || []).filter((item) => {
                return String(item.temp_id || item.id || '') !== String(itemId);
            });
            if ((req.session.cart[cartKey].items || []).length !== before) {
                removed = true;
            }
        });

        if (!removed) {
            return res.status(404).json({ success: false, message: 'ไม่พบรายการชั่วคราวในตะกร้า' });
        }

        return req.session.save((saveErr) => {
            if (saveErr) {
                console.error('Error removing temp cart item:', saveErr.message);
                return res.status(500).json({ success: false, message: 'ไม่สามารถลบรายการชั่วคราวได้' });
            }
            return res.json({ success: true });
        });
    }

    db.run('DELETE FROM ORDER_ITEM_OWNERS WHERE order_item_id = ?', [itemId], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'ไม่สามารถลบรายการได้' });

        db.run('DELETE FROM ORDER_ITEMS WHERE order_item_id = ?', [itemId], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'ไม่สามารถลบรายการได้' });
            res.json({ success: true });
        });
    });
});

app.post('/order/item/delete', (req, res) => {
    const { order_item_id, session_id, user_id } = req.body;

    db.run('DELETE FROM ORDER_ITEM_OWNERS WHERE order_item_id = ?', [order_item_id], (err) => {
        if (err) return res.status(500).send('ไม่สามารถลบรายการได้');

        db.run('DELETE FROM ORDER_ITEMS WHERE order_item_id = ?', [order_item_id], (err) => {
            if (err) return res.status(500).send('ไม่สามารถลบรายการได้');
            res.redirect(`/cart?session_id=${session_id}&user_id=${user_id}`);
        });
    });
});

// Reset Database API
app.delete('/resetdatabase', (req, res) => {
    const sql = `
        PRAGMA foreign_keys = OFF;
        DELETE FROM ORDER_ITEM_OWNERS;
        DELETE FROM ORDER_ITEMS;
        DELETE FROM ORDERS;
        DELETE FROM PAYMENTS;
        DELETE FROM SESSION_USERS;
        DELETE FROM SESSIONS;
        UPDATE TABLES SET status = 'AVAILABLE';
        DELETE FROM sqlite_sequence WHERE name IN (
            'SESSIONS', 
            'SESSION_USERS', 
            'ORDERS', 
            'ORDER_ITEMS', 
            'ORDER_ITEM_OWNERS', 
            'PAYMENTS'
        );
        PRAGMA foreign_keys = ON;
    `;

    db.exec(sql, function (err) {
        if (err) {
            console.log('Error deleting database:', err.message);
            return res.status(500).json({ error: err.message });
        }

        db.get('SELECT table_id FROM TABLES LIMIT 1', [], (err, tableRow) => {
            const createSession = (validTableId) => {
                const createSessionSql = `INSERT INTO SESSIONS (table_id, status) VALUES (?, 'active')`;

                db.run(createSessionSql, [validTableId], function (err) {
                    if (err) {
                        console.log('Error creating new session:', err.message);
                        return res.status(500).json({ error: 'ล้างฐานข้อมูลสำเร็จ แต่สร้าง Session ใหม่ไม่สำเร็จ: ' + err.message });
                    }

                    res.json({ 
                        message: 'Database reset and new session created successfully',
                        new_session_id: this.lastID,
                        table_id: validTableId
                    });
                });
            };

            if (tableRow) {
                createSession(tableRow.table_id);
            } else {
                const defaultTableId = req.body?.table_id || req.query?.table_id || 1;

                db.run(`INSERT INTO TABLES (table_id, status) VALUES (?, 'AVAILABLE')`, [defaultTableId], function (err) {
                    if (err) {
                        db.run(`INSERT INTO TABLES (status) VALUES ('AVAILABLE')`, [], function (err2) {
                            createSession(this.lastID || defaultTableId);
                        });
                    } else {
                        createSession(defaultTableId);
                    }
                });
            }
        });
    });
});

// -----------------------------------------------------------------------------
// 7. ส่วนงานแคชเชียร์ (Cashier)
// -----------------------------------------------------------------------------

// หน้าหลักแคชเชียร์ (แสดงผังโต๊ะ)
app.get('/cashier', (req, res) => {
    const sql = `
        SELECT 
            t.table_id,
            t.table_number,
            CASE 
                WHEN COUNT(s.session_id) > 0 THEN 'OCCUPIED'
                ELSE 'AVAILABLE'
            END AS status,
            CASE 
                WHEN COUNT(s.session_id) > 0 THEN 'OCCUPIED'
                ELSE 'AVAILABLE'
            END AS calculated_status
        FROM TABLES t
        LEFT JOIN SESSIONS s 
          ON CAST(s.table_id AS TEXT) = CAST(t.table_id AS TEXT) 
         AND LOWER(TRIM(s.status)) = 'active'
        GROUP BY t.table_id, t.table_number
        ORDER BY CAST(t.table_number AS INTEGER) ASC
    `;

    db.all(sql, [], (err, tables) => {
        if (err) {
            console.error('Error fetching tables:', err);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลโต๊ะ');
        }
        res.render('cashier', { tables: tables || [] });
    });
});

// หน้าแสดงรายละเอียดออเดอร์รายโต๊ะ
app.get('/cashier/table/:table_id', (req, res) => {
    const tableId = req.params.table_id;

    const sessionSql = `
        SELECT session_id 
        FROM SESSIONS 
        WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT) 
          AND LOWER(status) = 'active' 
        ORDER BY session_id DESC 
        LIMIT 1
    `;

    db.get(sessionSql, [tableId], (err, session) => {
        if (err) {
            console.error('Error fetching session:', err);
            return res.status(500).send('เกิดข้อผิดพลาดในระบบ');
        }

        if (!session) {
            return res.render('cas-tab-detail', { 
                tableId: tableId, 
                orders: [], 
                splitDetails: [], 
                totalPrice: 0 
            });
        }

        const sessionId = session.session_id;

        db.all(`SELECT user_id, name FROM SESSION_USERS WHERE session_id = ?`, [sessionId], (err, users) => {
            if (err) users = [];

            const orderSql = `
                SELECT 
                    oi.order_item_id,
                    oi.status as item_status,
                    mi.name,
                    mi.price,
                    mi.image_url,
                    oi.qty as quantity,
                    GROUP_CONCAT(su.name, ', ') as owner_names
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON oi.order_id = o.order_id
                JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                LEFT JOIN ORDER_ITEM_OWNERS oio ON oi.order_item_id = oio.order_item_id
                LEFT JOIN SESSION_USERS su ON oio.user_id = su.user_id
                WHERE o.session_id = ?
                GROUP BY oi.order_item_id
                ORDER BY oi.order_item_id DESC
            `;

            db.all(orderSql, [sessionId], (err, rawOrders) => {
                if (err) rawOrders = [];

                let totalPrice = 0;
                let userTotals = {};

                users.forEach(u => {
                    userTotals[u.name] = { total: 0, calcText: [] };
                });

                const processedOrders = rawOrders.map(order => {
                    const itemTotal = order.price * order.quantity;
                    totalPrice += itemTotal;

                    let tags = order.owner_names ? order.owner_names.split(', ') : [];

                    if (tags.length === 0) {
                        if (users.length > 0) {
                            const splitPrice = itemTotal / users.length;
                            users.forEach(u => {
                                if (userTotals[u.name]) {
                                    userTotals[u.name].total += splitPrice;
                                    userTotals[u.name].calcText.push(splitPrice.toFixed(2));
                                }
                            });
                        }
                    } else {
                        const splitPrice = itemTotal / tags.length;
                        tags.forEach(name => {
                            if (userTotals[name]) {
                                userTotals[name].total += splitPrice;
                                userTotals[name].calcText.push(splitPrice.toFixed(2));
                            }
                        });
                    }

                    return {
                        ...order,
                        tags: tags,
                        itemTotal: itemTotal,
                        splitPricePerPerson: tags.length > 0 
                            ? (itemTotal / tags.length) 
                            : (users.length > 0 ? itemTotal / users.length : itemTotal)
                    };
                });

                const splitDetails = Object.keys(userTotals).map(name => {
                    const detail = userTotals[name];
                    return {
                        name: name,
                        calcString: detail.calcText.length > 0 
                                    ? detail.calcText.join(' + ') + ` = ${detail.total.toFixed(2)}.-` 
                                    : `0.00.-`,
                        total: detail.total
                    };
                });

                res.render('cas-tab-detail', {
                    tableId: tableId,
                    orders: processedOrders,
                    splitDetails: splitDetails,
                    totalPrice: totalPrice
                });
            });
        });
    });
});

// หน้าแสดงการชำระเงินแยกจ่าย (Split Payment)
app.get('/cashier/table/:table_id/payment', (req, res) => {
    const tableId = req.params.table_id;
    const paymentMode = String(req.query.mode || '') === 'combined' ? 'combined' : 'split';

    const sessionSql = `
        SELECT session_id 
        FROM SESSIONS 
        WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT) 
          AND LOWER(status) = 'active' 
        ORDER BY session_id DESC 
        LIMIT 1
    `;

    db.get(sessionSql, [tableId], (err, session) => {
        if (err || !session) {
            return res.render('payment', {
                tableId: tableId,
                sessionId: null,
                paymentList: [],
                paidCount: 0,
                totalUsers: 0,
                paymentMode
            });
        }

        const sessionId = session.session_id;

        // ดึงคอลัมน์ is_paid เพิ่มเติมเพื่อแสดงผลสถานะชำระเงินของแต่ละคน
        const userSql = `
            SELECT user_id, name, is_paid 
            FROM SESSION_USERS 
            WHERE CAST(session_id AS TEXT) = CAST(? AS TEXT)
        `;

        db.all(userSql, [sessionId], (err, users) => {
            if (err) users = [];

            const orderSql = `
                SELECT 
                    oi.order_item_id,
                    mi.price,
                    oi.qty as quantity,
                    GROUP_CONCAT(su.user_id) as owner_ids
                FROM ORDER_ITEMS oi
                JOIN ORDERS o ON oi.order_id = o.order_id
                JOIN MENU_ITEMS mi ON oi.menu_item_id = mi.menu_item_id
                LEFT JOIN ORDER_ITEM_OWNERS oio ON oi.order_item_id = oio.order_item_id
                LEFT JOIN SESSION_USERS su ON oio.user_id = su.user_id
                WHERE o.session_id = ?
                GROUP BY oi.order_item_id
            `;

            db.all(orderSql, [sessionId], (err, items) => {
                if (err) items = [];

                let paymentList = [];

                if (paymentMode === 'combined') {
                    const totalTablePrice = items.reduce((total, item) => {
                        return total + (Number(item.price) || 0) * (Number(item.quantity) || 0);
                    }, 0);

                    if (totalTablePrice > 0) {
                        const finalAmount = totalTablePrice.toFixed(2);
                        paymentList = [{
                            user_id: 0,
                            name: `ชำระรวมทั้งโต๊ะ ${tableId}`,
                            amount: finalAmount,
                            isPaid: false,
                            qrUrl: `https://promptpay.io/${PROMPTPAY_NO}/${finalAmount}.png`
                        }];
                    }
                } else if (users.length > 0) {
                    let userPaymentData = {};

                    users.forEach(u => {
                        userPaymentData[u.user_id] = {
                            user_id: u.user_id,
                            name: u.name,
                            amount: 0,
                            isPaid: u.is_paid === 1
                        };
                    });

                    items.forEach(item => {
                        const itemTotal = item.price * item.quantity;
                        const owners = item.owner_ids ? item.owner_ids.split(',') : [];

                        if (owners.length === 0) {
                            const splitPrice = itemTotal / users.length;
                            users.forEach(u => {
                                userPaymentData[u.user_id].amount += splitPrice;
                            });
                        } else {
                            const splitPrice = itemTotal / owners.length;
                            owners.forEach(uId => {
                                if (userPaymentData[uId]) {
                                    userPaymentData[uId].amount += splitPrice;
                                }
                            });
                        }
                    });

                    paymentList = Object.values(userPaymentData).map(u => {
                        const finalAmount = u.amount.toFixed(2);
                        return {
                            user_id: u.user_id,
                            name: u.name,
                            amount: finalAmount,
                            isPaid: u.isPaid,
                            qrUrl: `https://promptpay.io/${PROMPTPAY_NO}/${finalAmount}.png`
                        };
                    });
                } else {
                    let totalTablePrice = 0;
                    items.forEach(item => {
                        totalTablePrice += (item.price * item.quantity);
                    });

                    if (totalTablePrice > 0) {
                        const finalAmount = totalTablePrice.toFixed(2);
                        paymentList = [{
                            user_id: 0,
                            name: `ลูกค้าโต๊ะ ${tableId} (ชำระรวม)`,
                            amount: finalAmount,
                            isPaid: false,
                            qrUrl: `https://promptpay.io/${PROMPTPAY_NO}/${finalAmount}.png`
                        }];
                    }
                }

                const paidCount = paymentList.filter(p => p.isPaid).length;

                res.render('payment', {
                    tableId: tableId,
                    sessionId: sessionId,
                    paymentList: paymentList,
                    paidCount: paidCount,
                    totalUsers: paymentList.length,
                    paymentMode
                });
            });
        });
    });
});

// สลับสถานะการชำระเงิน (จ่ายแล้ว <-> รอชำระ)
app.post('/cashier/table/:table_id/toggle-user-paid', (req, res) => {
    const { userId, isPaid } = req.body;
    const tableId = req.params.table_id;

    if (userId === '0') {
        return res.redirect(`/cashier/table/${tableId}/payment`);
    }

    const nextStatus = isPaid === 'true' ? 0 : 1;

    db.run(`UPDATE SESSION_USERS SET is_paid = ? WHERE user_id = ?`, [nextStatus, userId], (err) => {
        if (err) console.error('Error updating paid status:', err.message);
        res.redirect(`/cashier/table/${tableId}/payment`);
    });
});

// บันทึกยอดชำระเงินและปิด session ของโต๊ะ
app.post('/cashier/table/:table_id/finish-payment', (req, res) => {
    const tableId = req.params.table_id;
    const paymentMode = String(req.body.paymentMode || '') === 'combined' ? 'combined' : 'split';
    const failTransaction = (message, err) => {
        console.error(`[Finish Payment Error] ${message}:`, err.message);
        db.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) console.error('[Finish Payment Error] ROLLBACK:', rollbackErr.message);
            res.status(500).send('เกิดข้อผิดพลาดในการบันทึกการชำระเงิน');
        });
    };

    db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
        if (beginErr) {
            console.error('[Finish Payment Error] BEGIN:', beginErr.message);
            return res.status(500).send('ไม่สามารถเริ่มบันทึกการชำระเงินได้');
        }

        db.get(
            `SELECT s.session_id, s.table_id
             FROM SESSIONS s
             JOIN TABLES t ON t.table_id = s.table_id
             WHERE CAST(s.table_id AS TEXT) = CAST(? AS TEXT)
               AND LOWER(TRIM(s.status)) = 'active'
             ORDER BY s.session_id DESC
             LIMIT 1`,
            [tableId],
            (sessionErr, sessionRow) => {
                if (sessionErr) return failTransaction('SESSION LOOKUP', sessionErr);
                if (!sessionRow) {
                    return db.run('ROLLBACK', (rollbackErr) => {
                        if (rollbackErr) console.error('[Finish Payment Error] ROLLBACK:', rollbackErr.message);
                        res.redirect('/cashier');
                    });
                }

                db.all(
                    'SELECT user_id, is_paid FROM SESSION_USERS WHERE session_id = ?',
                    [sessionRow.session_id],
                    (usersErr, users) => {
                        if (usersErr) return failTransaction('USER LOOKUP', usersErr);

                        db.all(
                            `SELECT oi.order_item_id, oi.qty, mi.price,
                                    GROUP_CONCAT(DISTINCT su.user_id) AS owner_ids
                             FROM ORDER_ITEMS oi
                             JOIN ORDERS o ON o.order_id = oi.order_id
                             JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
                             LEFT JOIN ORDER_ITEM_OWNERS oio ON oio.order_item_id = oi.order_item_id
                             LEFT JOIN SESSION_USERS su ON su.user_id = oio.user_id
                             WHERE o.session_id = ?
                             GROUP BY oi.order_item_id`,
                            [sessionRow.session_id],
                            (itemsErr, items) => {
                                if (itemsErr) return failTransaction('ORDER LOOKUP', itemsErr);

                                const paymentRows = [];
                                if (paymentMode === 'combined' || users.length === 0) {
                                    const amount = (items || []).reduce((total, item) => (
                                        total + (Number(item.price) || 0) * (Number(item.qty) || 0)
                                    ), 0);
                                    if (amount > 0) {
                                        paymentRows.push({
                                            userId: null,
                                            amount: Number(amount.toFixed(2)),
                                            status: 'paid'
                                        });
                                    }
                                } else {
                                    const userTotals = new Map(users.map((user) => [
                                        String(user.user_id),
                                        { amount: 0, isPaid: Number(user.is_paid) === 1 }
                                    ]));

                                    (items || []).forEach((item) => {
                                        const itemTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
                                        const owners = [...new Set(String(item.owner_ids || '').split(',').filter(Boolean))];
                                        const splitOwners = owners.length > 0
                                            ? owners
                                            : [...userTotals.keys()];
                                        const perOwnerAmount = itemTotal / splitOwners.length;

                                        splitOwners.forEach((userId) => {
                                            const userTotal = userTotals.get(userId);
                                            if (userTotal) userTotal.amount += perOwnerAmount;
                                        });
                                    });

                                    userTotals.forEach((userTotal, userId) => {
                                        if (userTotal.amount > 0) {
                                            paymentRows.push({
                                                userId,
                                                amount: Number(userTotal.amount.toFixed(2)),
                                                status: userTotal.isPaid ? 'paid' : 'pending'
                                            });
                                        }
                                    });
                                }

                                const insertPayment = (index) => {
                                    if (index >= paymentRows.length) return closeTable();

                                    const payment = paymentRows[index];
                                    db.run(
                                        `INSERT INTO PAYMENTS (session_id, user_id, amount, method, status)
                                         VALUES (?, ?, ?, 'PromptPay', ?)`,
                                        [sessionRow.session_id, payment.userId, payment.amount, payment.status],
                                        (insertErr) => {
                                            if (insertErr) return failTransaction('PAYMENT INSERT', insertErr);
                                            insertPayment(index + 1);
                                        }
                                    );
                                };

                                const closeTable = () => {
                                    db.run(
                                        "UPDATE SESSIONS SET status = 'completed' WHERE session_id = ? AND LOWER(TRIM(status)) = 'active'",
                                        [sessionRow.session_id],
                                        function (sessionUpdateErr) {
                                            if (sessionUpdateErr) return failTransaction('SESSION UPDATE', sessionUpdateErr);
                                            if (this.changes === 0) {
                                                return failTransaction('SESSION UPDATE', new Error('Active session changed before payment finished.'));
                                            }

                                            db.run(
                                                "UPDATE TABLES SET status = 'AVAILABLE' WHERE table_id = ?",
                                                [sessionRow.table_id],
                                                (tableUpdateErr) => {
                                                    if (tableUpdateErr) return failTransaction('TABLE UPDATE', tableUpdateErr);

                                                    db.run('COMMIT', (commitErr) => {
                                                        if (commitErr) return failTransaction('COMMIT', commitErr);
                                                        res.redirect('/cashier');
                                                    });
                                                }
                                            );
                                        }
                                    );
                                };

                                insertPayment(0);
                            }
                        );
                    }
                );
            }
        );
    });
});

// -----------------------------------------------------------------------------
// 8. ส่วนงานครัว (Kitchen)
// -----------------------------------------------------------------------------
const ST = { PENDING: 'pending', ORDERED: 'ordered', COOKING: 'cooking', READY: 'ready', SERVED: 'served', CANCELLED: 'cancelled' };
// key = สถานะปลายทาง, value = สถานะที่ต้องเป็นอยู่ก่อน
const KITCHEN_STEP = { ordered: 'cooking', ready: 'cooking', cooking: 'ready' };
// พนักงานเสิร์ฟกดได้แบบเดียว: พร้อมเสิร์ฟ -> เสิร์ฟแล้ว (ใช้ที่หน้ารายละเอียดคำสั่งซื้อ)
const SERVE_STEP = { served: 'ready' };
// ข้อความแจ้งเตือนที่อนุญาตให้แสดงผ่าน query msg (กันการพิมพ์ค่าดิบจากผู้ใช้)
const KITCHEN_MSG = ['taken', 'invalid', 'changed'];

// แต่งแถว ORDER_ITEMS ให้พร้อมแสดงผล (เวลาไทย ป้ายใหม่ นาทีที่รอ ยอดเงิน เหตุผลยกเลิก)
function makeItem(r, now) {
    const sentMs = r.sent_at ? new Date(String(r.sent_at).replace(' ', 'T') + 'Z').getTime() : NaN;
    const price = Number(r.price) || 0;
    const qty = Number(r.qty) || 0;
    return {
        order_item_id: r.order_item_id,
        table_id: r.table_id,
        table_number: r.table_number,
        qty: r.qty,
        note: r.note,
        status: r.status,
        name: r.name,
        price: price,
        lineTotal: price * qty,
        cancel_reason: r.cancel_reason || '',
        timeTh: isNaN(sentMs) ? '-' : new Date(sentMs).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }),
        isNew: !isNaN(sentMs) && (now - sentMs) >= 0 && (now - sentMs) <= 60000,
        waitMin: isNaN(sentMs) ? 0 : Math.max(0, Math.floor((now - sentMs) / 60000))
    };
}

// 8.1 หน้าครัว (บิลที่ลูกค้าส่งมา บิลใหม่สุดขึ้นก่อน กดรับแล้วปุ่มกลายเป็นอัพเดท)
app.get('/kitchen', (req, res) => {
    const rawMsg = String(req.query.msg || '');
    const msg = KITCHEN_MSG.includes(rawMsg) ? rawMsg : '';

    const sql = `
        SELECT t.table_id, t.table_number, o.order_id, oi.order_item_id, oi.qty, oi.note, oi.status,
               COALESCE(oi.sent_at, o.created_at) AS sent_at, mi.name, mi.price
        FROM ORDER_ITEMS oi
        JOIN ORDERS o     ON o.order_id = oi.order_id
        JOIN SESSIONS s   ON s.session_id = o.session_id
        JOIN TABLES t     ON CAST(t.table_id AS TEXT) = CAST(s.table_id AS TEXT)
        JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
        WHERE oi.status IN ('ordered', 'cooking') AND LOWER(TRIM(s.status)) = 'active'
        ORDER BY CASE oi.status WHEN 'ordered' THEN 0 ELSE 1 END,
                 sent_at DESC, oi.order_item_id DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching kitchen orders:', err.message);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลออเดอร์ครัว');
        }

        // จัดแถวเป็นบิล (โต๊ะ + ออเดอร์ + รอบเวลาส่ง + สถานะ เดียวกัน = บิลเดียว)
        const now = Date.now();
        const groups = {};
        const bills = [];
        (rows || []).forEach((r) => {
            const key = [r.table_id, r.order_id, String(r.sent_at), r.status].join('|');
            if (!groups[key]) {
                groups[key] = { table_id: r.table_id, table_number: r.table_number, status: r.status, items: [] };
                bills.push(groups[key]);
            }
            groups[key].items.push(makeItem(r, now));
        });
        // เติมยอดรวม เวลา ป้าย และ id สำหรับปุ่มรับของแต่ละบิล
        bills.forEach((b) => {
            b.total = 0;
            b.maxWait = 0;
            b.hasNew = false;
            b.items.forEach((i) => {
                b.total += i.lineTotal;
                if (i.waitMin > b.maxWait) b.maxWait = i.waitMin;
                if (i.isNew) b.hasNew = true;
            });
            b.firstTimeTh = b.items[0].timeTh;
            b.ids = b.items.map((i) => i.order_item_id).join(',');
            b.action = (b.status === ST.ORDERED) ? 'accept' : 'update';
        });

        res.render('kitchen', { bills: bills, dishes: [], tables: [], msg: msg, mode: 'kitchen', page: 'kitchen', title: 'ครัว - รายการอาหาร' });
    });
});

// 8.2 ครัวรับงาน (ordered -> cooking กันรับซ้ำแบบ atomic)
app.post('/kitchen/accept', (req, res) => {
    const idList = String(req.body.ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
    if (idList.length === 0) {
        return res.redirect('/kitchen?msg=invalid');
    }

    db.get("SELECT employee_id FROM EMPLOYEES WHERE role = 'kitchen' LIMIT 1", [], (err, emp) => {
        if (err || !emp) {
            console.error('Error finding kitchen employee:', err ? err.message : 'not found');
            return res.status(500).send('เกิดข้อผิดพลาดในการรับรายการอาหาร');
        }

        const marks = idList.map(() => '?').join(',');
        const sqlUpdate = `UPDATE ORDER_ITEMS SET status = 'cooking', updated_by_employee_id = ?
            WHERE order_item_id IN (${marks}) AND status = 'ordered'`;

        db.run(sqlUpdate, [emp.employee_id, ...idList], function (err) {
            if (err) {
                console.error('Error accepting kitchen order:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการรับรายการอาหาร');
            }
            if (this.changes === 0) {
                return res.redirect('/kitchen?msg=taken');
            }
            res.redirect('/kitchen/orders');
        });
    });
});

// 8.3 หน้าออเดอร์ที่ต้องทำ (แยกจานต่อจาน เฉพาะกำลังปรุง จานใหม่สุดก่อน ปุ่มเดียวคือปรุงเสร็จ)
app.get(['/kitchen/ordered', '/kitchen/orders'], (req, res) => {
    const rawMsg = String(req.query.msg || '');
    const msg = KITCHEN_MSG.includes(rawMsg) ? rawMsg : '';

    const sql = `
        SELECT t.table_id, t.table_number, oi.order_item_id, oi.qty, oi.note, oi.status,
               COALESCE(oi.sent_at, o.created_at) AS sent_at, mi.name, mi.price
        FROM ORDER_ITEMS oi
        JOIN ORDERS o     ON o.order_id = oi.order_id
        JOIN SESSIONS s   ON s.session_id = o.session_id
        JOIN TABLES t     ON CAST(t.table_id AS TEXT) = CAST(s.table_id AS TEXT)
        JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
        WHERE oi.status = 'cooking' AND LOWER(TRIM(s.status)) = 'active'
        ORDER BY sent_at DESC, oi.order_item_id DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching cooking dishes:', err.message);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลออเดอร์ที่ต้องทำ');
        }

        const now = Date.now();
        const dishes = [];
        (rows || []).forEach((r) => {
            const item = makeItem(r, now);
            item.table_id = r.table_id;
            item.table_number = r.table_number;
            dishes.push(item);
        });

        res.render('kitchen', { bills: [], dishes: dishes, tables: [], msg: msg, mode: 'ordered', page: 'orders', title: 'ออเดอร์ที่ต้องทำ' });
    });
});

// 8.4 หน้าอัพเดทสถานะ (แสดงรายการอาหารทั้งหมด เรียงตามสถานะ)
app.get('/kitchen/status', (req, res) => {
    const sql = `
        SELECT t.table_id, t.table_number, oi.order_item_id, oi.qty, oi.note, oi.status, oi.cancel_reason,
               COALESCE(oi.sent_at, o.created_at) AS sent_at, mi.name, mi.price
        FROM ORDER_ITEMS oi
        JOIN ORDERS o     ON o.order_id = oi.order_id
        JOIN SESSIONS s   ON s.session_id = o.session_id
        JOIN TABLES t     ON CAST(t.table_id AS TEXT) = CAST(s.table_id AS TEXT)
        JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
        WHERE oi.status IN ('ordered', 'cooking', 'ready', 'cancelled', 'served')
          AND LOWER(TRIM(s.status)) = 'active'
        ORDER BY CASE oi.status
            WHEN 'ordered' THEN 1
            WHEN 'cooking' THEN 2
            WHEN 'ready' THEN 3
            WHEN 'served' THEN 4
            WHEN 'cancelled' THEN 5
            ELSE 6
        END, sent_at DESC, oi.order_item_id DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching kitchen status items:', err.message);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงรายการอาหาร');
        }

        const now = Date.now();
        const dishes = (rows || []).map((row) => makeItem(row, now));
        const tableMap = new Map();
        dishes.forEach((item) => {
            const key = String(item.table_id);
            if (!tableMap.has(key)) {
                tableMap.set(key, {
                    table_id: item.table_id,
                    table_number: item.table_number,
                    items: []
                });
            }
            tableMap.get(key).items.push(item);
        });
        const tableGroups = Array.from(tableMap.values())
            .sort((a, b) => String(a.table_number).localeCompare(String(b.table_number), undefined, { numeric: true }));
        const rawMsg = String(req.query.msg || '');
        const msg = KITCHEN_MSG.includes(rawMsg) ? rawMsg : '';
        res.render('kitchen', {
            bills: [],
            dishes,
            tableGroups,
            tables: [],
            msg,
            mode: 'status',
            page: 'status',
            title: 'อัพเดทสถานะอาหาร'
        });
    });
});

app.get('/kitchen/table', (req, res) => {
    res.redirect('/kitchen/orders');
});

// 8.5 หน้ารายละเอียดรายโต๊ะ (แยก 4 กอง: รอรับ กำลังปรุง พร้อมเสิร์ฟ ยกเลิกแล้ว)
app.get('/kitchen/table/:table_id', (req, res) => {
    const tableId = req.params.table_id;
    const rawMsg = String(req.query.msg || '');
    const msg = KITCHEN_MSG.includes(rawMsg) ? rawMsg : '';
    // จำหน้ามาเพื่อไฮไลต์แท็บและปุ่มกลับให้ถูก (kitchen / status / orders)
    const rawFrom = String(req.query.from || '');
    const fromPage = ['kitchen', 'status', 'orders'].includes(rawFrom) ? rawFrom : 'status';
    const backUrl = fromPage === 'kitchen' ? '/kitchen'
        : (fromPage === 'orders' ? '/kitchen/orders' : '/kitchen/status');
    const backText = fromPage === 'kitchen' ? 'กลับหน้าครัว'
        : (fromPage === 'orders' ? 'กลับหน้าออร์เดอร์ที่ต้องทำ' : 'กลับหน้าอัพเดท');

    db.get('SELECT table_id, table_number FROM TABLES WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT)', [tableId], (err, table) => {
        if (err) {
            console.error('Error fetching kitchen table:', err.message);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลโต๊ะครัว');
        }
        const tableInfo = table || { table_id: tableId, table_number: tableId };

        const sql = `
            SELECT oi.order_item_id, oi.qty, oi.note, oi.status, oi.cancel_reason,
                   COALESCE(oi.sent_at, o.created_at) AS sent_at, mi.name
            FROM ORDER_ITEMS oi
            JOIN ORDERS o     ON o.order_id = oi.order_id
            JOIN SESSIONS s   ON s.session_id = o.session_id
            JOIN TABLES t     ON CAST(t.table_id AS TEXT) = CAST(s.table_id AS TEXT)
            JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
            WHERE oi.status IN ('ordered', 'cooking', 'ready', 'cancelled', 'served')
              AND LOWER(TRIM(s.status)) = 'active'
              AND CAST(t.table_id AS TEXT) = CAST(? AS TEXT)
            ORDER BY sent_at DESC, oi.order_item_id DESC
        `;

        db.all(sql, [tableId], (err, rows) => {
            if (err) {
                console.error('Error fetching kitchen table items:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลรายการของโต๊ะ');
            }

            const now = Date.now();
            const ordered = [];
            const cooking = [];
            const ready = [];
            const served = [];
            const cancelled = [];
            (rows || []).forEach((r) => {
                const item = makeItem(r, now);
                if (r.status === ST.ORDERED) ordered.push(item);
                else if (r.status === ST.COOKING) cooking.push(item);
                else if (r.status === ST.READY) ready.push(item);
                else if (r.status === ST.SERVED) served.push(item);
                else cancelled.push(item);
            });

            res.render('kitchen-detail', { table: tableInfo, ordered: ordered, cooking: cooking, ready: ready, served: served, cancelled: cancelled, msg: msg, page: fromPage, backUrl: backUrl, backText: backText });
        });
    });
});

// 8.6 เปลี่ยนสถานะรายจาน (ครัว: cooking <-> ready / เสิร์ฟ: ready -> served / ยกเลิก: ต้องมีเหตุผล)
app.post('/kitchen/item/:id/status', (req, res) => {
    const itemId = Number(req.params.id);
    const to = String(req.body.to || '');
    const tableId = String(req.body.table_id || '');
    const backTo = /^[0-9]+$/.test(tableId) ? '/kitchen/table/' + tableId : '/kitchen';
    const wantsJson = (req.get('accept') || '').includes('application/json');
    // หน้าที่กดปุ่มมา (ให้เด้งกลับหน้านั้น): รายละเอียดเสิร์ฟ หรือ ออเดอร์ที่ต้องทำ
    const BACK_OK = ['/orders', '/kitchen/ordered', '/kitchen/orders', '/kitchen/status'];
    const rawBack = String(req.body.back || '');
    const homeBack = BACK_OK.includes(rawBack) ? rawBack : null;
    const backWithMsg = (key) => (homeBack || backTo) + ((homeBack || backTo).includes('?') ? '&' : '?') + 'msg=' + key;
    const respondError = (key, statusCode) => {
        if (wantsJson) return res.status(statusCode).json({ error: key });
        return res.redirect(backWithMsg(key));
    };

    // ยกเลิกต้องพิมพ์เหตุผลมาด้วย (เสิร์ฟแล้วห้ามยกเลิก)
    const isCancel = (to === ST.CANCELLED);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    let stepMap = null;
    if (Object.prototype.hasOwnProperty.call(KITCHEN_STEP, to)) stepMap = KITCHEN_STEP;
    else if (Object.prototype.hasOwnProperty.call(SERVE_STEP, to)) stepMap = SERVE_STEP;
    if (!Number.isInteger(itemId) || itemId <= 0) {
        return respondError('invalid', 400);
    }
    if (isCancel && reason === '') {
        return respondError('invalid', 400);
    }
    if (!isCancel && !stepMap) {
        return respondError('invalid', 400);
    }

    db.get("SELECT employee_id FROM EMPLOYEES WHERE role = 'kitchen' LIMIT 1", [], (err, emp) => {
        if (err || !emp) {
            console.error('Error finding kitchen employee:', err ? err.message : 'not found');
            if (wantsJson) return res.status(500).json({ error: 'server' });
            return res.status(500).send('เกิดข้อผิดพลาดในการอัปเดตสถานะอาหาร');
        }

        // ตอบกลับเหมือนกันทั้งสองทาง: ไม่เปลี่ยนแถว = สถานะไม่ตรงแล้ว
        const afterUpdate = function (err) {
            if (err) {
                console.error('Error updating kitchen item status:', err.message);
                if (wantsJson) return res.status(500).json({ error: 'server' });
                return res.status(500).send('เกิดข้อผิดพลาดในการอัปเดตสถานะอาหาร');
            }
            if (this.changes === 0) {
                return respondError('changed', 409);
            }
            if (wantsJson) return res.json({ ok: true, orderItemId: itemId, status: to });
            res.redirect(homeBack || backTo);
        };

        if (isCancel) {
            db.run("UPDATE ORDER_ITEMS SET status = 'cancelled', cancel_reason = ?, updated_by_employee_id = ? WHERE order_item_id = ? AND status IN ('ordered', 'cooking')",
                [reason, emp.employee_id, itemId], afterUpdate);
        } else {
            const from = stepMap[to];
            db.run('UPDATE ORDER_ITEMS SET status = ?, updated_by_employee_id = ? WHERE order_item_id = ? AND status = ?',
                [to, emp.employee_id, itemId, from], afterUpdate);
        }
    });
});

// 8.7 หน้ารายละเอียดคำสั่งซื้อ (พนักงานเสิร์ฟ/แคชเชียร์ดูได้: เห็นทุกบิล บิลใหม่ขึ้นก่อน)
app.get('/orders', (req, res) => {
    const rawMsg = String(req.query.msg || '');
    const msg = KITCHEN_MSG.includes(rawMsg) ? rawMsg : '';

    const sql = `
        SELECT t.table_id, t.table_number, o.order_id, oi.order_item_id, oi.qty, oi.note, oi.status, oi.cancel_reason,
               COALESCE(oi.sent_at, o.created_at) AS sent_at, mi.name, mi.price
        FROM ORDER_ITEMS oi
        JOIN ORDERS o     ON o.order_id = oi.order_id
        JOIN SESSIONS s   ON s.session_id = o.session_id
        JOIN TABLES t     ON CAST(t.table_id AS TEXT) = CAST(s.table_id AS TEXT)
        JOIN MENU_ITEMS mi ON mi.menu_item_id = oi.menu_item_id
        WHERE oi.status IN ('ordered', 'cooking', 'ready', 'cancelled') AND LOWER(TRIM(s.status)) = 'active'
        ORDER BY sent_at DESC, oi.order_item_id DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching order details:', err.message);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลคำสั่งซื้อ');
        }

        const now = Date.now();
        const groups = {};
        const bills = [];
        (rows || []).forEach((r) => {
            const key = [r.table_id, r.order_id, String(r.sent_at), r.status].join('|');
            if (!groups[key]) {
                groups[key] = { table_id: r.table_id, table_number: r.table_number, status: r.status, items: [] };
                bills.push(groups[key]);
            }
            groups[key].items.push(makeItem(r, now));
        });
        bills.forEach((b) => {
            b.total = 0;
            b.maxWait = 0;
            b.hasNew = false;
            b.items.forEach((i) => {
                b.total += i.lineTotal;
                if (i.waitMin > b.maxWait) b.maxWait = i.waitMin;
                if (i.isNew) b.hasNew = true;
            });
            b.firstTimeTh = b.items[0].timeTh;
            b.ids = b.items.map((i) => i.order_item_id).join(',');
            if (b.status === ST.ORDERED) b.action = 'accept';
            else if (b.status === ST.COOKING) b.action = 'update';
            else if (b.status === ST.READY) b.action = 'serve';
            else b.action = 'none';
        });

        res.render('kitchen', { bills: bills, dishes: [], tables: [], msg: msg, mode: 'server', page: '', title: 'รายละเอียดคำสั่งซื้อ' });
    });
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running at http://localhost:${PORT}`);
    });
}
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middlewares
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

        res.render('index', {
            sessionId: sessionId,
            shopName: "ไอทีม่วนแจ่ม",
            existingUsers: existingUsers,
            instructions: [
                "ใส่ชื่อเล่นของคุณและเริ่มสั่งอาหาร",
                "เพิ่มรายการได้ทุกเมื่อ",
                "แยกจ่ายเงินและจ่ายตามที่คุณต้องการ"
            ]
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
// 3. รับฟอร์มเพิ่มรายการอาหารลงตะกร้า (status = 'pending')
// -----------------------------------------------------------------------------
app.post('/order/add', (req, res) => {
    const { session_id, user_id, menu_item_id, qty, note, shared_user_ids } = req.body;
    const itemQty = parseInt(qty) || 1;

    let ownersList = [];
    if (Array.isArray(shared_user_ids)) {
        ownersList = shared_user_ids;
    } else if (shared_user_ids) {
        ownersList = [shared_user_ids];
    } else {
        ownersList = [user_id];
    }

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [session_id], (err, order) => {
        if (err) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบออเดอร์');

        const insertOrderItem = (orderId) => {
            const sqlItem = `INSERT INTO ORDER_ITEMS (order_id, menu_item_id, qty, note, status) VALUES (?, ?, ?, ?, 'pending')`;

            db.run(sqlItem, [orderId, menu_item_id, itemQty, note || ''], function (err) {
                if (err) return res.status(500).send('ไม่สามารถเพิ่มรายการอาหารได้');

                const orderItemId = this.lastID;
                if (ownersList.length === 0) {
                    return res.redirect(`/menu?session_id=${session_id}&user_id=${user_id}`);
                }

                const placeholders = ownersList.map(() => '(?, ?)').join(', ');
                const sqlOwners = `INSERT INTO ORDER_ITEM_OWNERS (order_item_id, user_id) VALUES ${placeholders}`;

                const ownerParams = [];
                ownersList.forEach(uId => {
                    ownerParams.push(orderItemId, uId);
                });

                db.run(sqlOwners, ownerParams, (err) => {
                    if (err) console.error('Error inserting item owners:', err.message);
                    res.redirect(`/menu?session_id=${session_id}&user_id=${user_id}`);
                });
            });
        };

        if (!order) {
            db.run('INSERT INTO ORDERS (session_id, status) VALUES (?, "active")', [session_id], function (err) {
                if (err) return res.status(500).send('เกิดข้อผิดพลาดในการสร้างออเดอร์');
                insertOrderItem(this.lastID);
            });
        } else {
            insertOrderItem(order.order_id);
        }
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

            db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND LOWER(status) = "active"', [session_id], (err, order) => {
                if (err || !order) {
                    return res.render('cart', {
                        currentUser,
                        sessionUsers,
                        cartItems: [],
                        myTotalAmount: 0,
                        tableTotalAmount: 0,
                        myItemsCount: 0,
                        tableNo: session_id,
                        sessionId: session_id,
                        userId: user_id
                    });
                }

                const query = `
                    SELECT 
                        oi.order_item_id AS id,
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

                    let myTotalAmount = 0;
                    let tableTotalAmount = 0;
                    let myItemsCount = 0;

                    const cartItems = rawItems.map(item => {
                        const itemTotal = item.price * item.quantity;
                        tableTotalAmount += itemTotal;

                        const ownerIds = item.owner_ids ? item.owner_ids.split(',') : [];
                        const ownerNamesList = item.owner_names ? item.owner_names.split(',') : [];
                        const shareCount = ownerIds.length || 1;
                        const pricePerPerson = itemTotal / shareCount;

                        const isMyItem = ownerIds.includes(String(user_id));

                        if (isMyItem) {
                            myTotalAmount += pricePerPerson;
                            myItemsCount += 1;
                        }

                        return {
                            ...item,
                            itemTotal,
                            ownerIds,
                            ownerNames: ownerNamesList.join(', '),
                            shareCount,
                            pricePerPerson,
                            isMyItem
                        };
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
                totalUsers: 0
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

                if (users.length > 0) {
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
                    totalUsers: paymentList.length
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

// ปุ่มเสร็จสิ้น (ปิดโต๊ะ + เคลียร์ Active Session ทั้งหมด)
app.post('/cashier/table/:table_id/finish-payment', (req, res) => {
    const tableId = req.params.table_id;

    const updateSessionsSql = `
        UPDATE SESSIONS 
        SET status = 'completed' 
        WHERE LOWER(TRIM(status)) = 'active'
          AND (
            CAST(table_id AS TEXT) = CAST(? AS TEXT)
            OR table_id IN (
                SELECT t2.table_id 
                FROM TABLES t1 
                JOIN TABLES t2 ON t1.table_number = t2.table_number 
                WHERE CAST(t1.table_id AS TEXT) = CAST(? AS TEXT)
            )
          )
    `;

    db.run(updateSessionsSql, [tableId, tableId], (err) => {
        if (err) console.error('[Finish Payment Error] SESSIONS:', err);

        const updateTablesSql = `
            UPDATE TABLES 
            SET status = 'AVAILABLE' 
            WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT)
               OR table_number IN (
                   SELECT table_number FROM TABLES WHERE CAST(table_id AS TEXT) = CAST(? AS TEXT)
               )
        `;

        db.run(updateTablesSql, [tableId, tableId], (err) => {
            if (err) console.error('[Finish Payment Error] TABLES:', err);
            res.redirect('/cashier');
        });
    });
});

// -----------------------------------------------------------------------------
// 8. ส่วนงานครัว (Kitchen)
// -----------------------------------------------------------------------------
const ST = { PENDING: 'pending', ORDERED: 'ordered', COOKING: 'cooking', READY: 'ready', SERVED: 'served', CANCELLED: 'cancelled' };
// ครัวเปลี่ยนสถานะรายจานได้แค่ 2 แบบ: key = สถานะปลายทาง, value = สถานะที่ต้องเป็นอยู่ก่อน
const KITCHEN_STEP = { ready: 'cooking', cooking: 'ready' };
// พนักงานเสิร์ฟกดได้แบบเดียว: พร้อมเสิร์ฟ -> เสิร์ฟแล้ว (ใช้ที่หน้ารายละเอียดคำสั่งซื้อ)
const SERVE_STEP = { served: 'ready' };
// ข้อความแจ้งเตือนที่อนุญาตให้แสดงผ่าน query msg (กันการพิมพ์ค่าดิบจากผู้ใช้)
const KITCHEN_MSG = ['taken', 'invalid', 'changed'];

// Migration ฝั่งครัว (รันซ้ำได้): เพิ่มคอลัมน์ sent_at + seed พนักงานครัว 1 แถว
function migrateKitchen() {
    db.all('PRAGMA table_info(ORDER_ITEMS)', [], (err, cols) => {
        if (err) {
            console.error('Kitchen migration ตรวจสอบคอลัมน์ไม่สำเร็จ:', err.message);
            return;
        }
        const hasSentAt = (cols || []).some((c) => c.name === 'sent_at');
        if (!hasSentAt) {
            db.run('ALTER TABLE ORDER_ITEMS ADD COLUMN sent_at DATETIME', (err) => {
                if (err) {
                    console.error('Kitchen migration เพิ่มคอลัมน์ sent_at ไม่สำเร็จ:', err.message);
                } else {
                    console.log('Kitchen migration เพิ่มคอลัมน์ sent_at แล้ว');
                }
            });
        }
        // ที่เก็บเหตุผลยกเลิก (แยกคอลัมน์ ไม่เขียนทับ note ของลูกค้า)
        const hasReason = (cols || []).some((c) => c.name === 'cancel_reason');
        if (!hasReason) {
            db.run('ALTER TABLE ORDER_ITEMS ADD COLUMN cancel_reason TEXT', (err) => {
                if (err) {
                    console.error('Kitchen migration เพิ่มคอลัมน์ cancel_reason ไม่สำเร็จ:', err.message);
                } else {
                    console.log('Kitchen migration เพิ่มคอลัมน์ cancel_reason แล้ว');
                }
            });
        }
    });

    db.get("SELECT employee_id FROM EMPLOYEES WHERE role = 'kitchen' LIMIT 1", [], (err, row) => {
        if (err) {
            console.error('Kitchen migration ตรวจสอบพนักงานครัวไม่สำเร็จ:', err.message);
            return;
        }
        if (!row) {
            db.run("INSERT INTO EMPLOYEES (name, role) VALUES ('พนักงานครัว', 'kitchen')", (err) => {
                if (err) {
                    console.error('Kitchen migration เพิ่มพนักงานครัวไม่สำเร็จ:', err.message);
                } else {
                    console.log('Kitchen migration เพิ่มพนักงานครัวแล้ว');
                }
            });
        }
    });
}

migrateKitchen();

// แต่งแถว ORDER_ITEMS ให้พร้อมแสดงผล (เวลาไทย ป้ายใหม่ นาทีที่รอ ยอดเงิน เหตุผลยกเลิก)
function makeItem(r, now) {
    const sentMs = r.sent_at ? new Date(String(r.sent_at).replace(' ', 'T') + 'Z').getTime() : NaN;
    const price = Number(r.price) || 0;
    const qty = Number(r.qty) || 0;
    return {
        order_item_id: r.order_item_id,
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
        ORDER BY sent_at DESC, oi.order_item_id DESC
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
            res.redirect('/kitchen');
        });
    });
});

// 8.3 หน้าออเดอร์ที่ต้องทำ (แยกจานต่อจาน เฉพาะกำลังปรุง จานใหม่สุดก่อน ปุ่มเดียวคือปรุงเสร็จ)
app.get('/kitchen/ordered', (req, res) => {
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

        res.render('kitchen', { bills: [], dishes: dishes, tables: [], msg: msg, mode: 'ordered', page: 'ordered', title: 'ออเดอร์ที่ต้องทำ' });
    });
});

// 8.4 หน้าอัพเดทสถานะ (รายชื่อโต๊ะที่มีงานค้าง กดเข้าไปได้)
app.get('/kitchen/status', (req, res) => {
    const sql = `
        SELECT t.table_id, t.table_number,
               COUNT(*) AS total,
               SUM(CASE WHEN oi.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM ORDER_ITEMS oi
        JOIN ORDERS o     ON o.order_id = oi.order_id
        JOIN SESSIONS s   ON s.session_id = o.session_id
        JOIN TABLES t     ON CAST(t.table_id AS TEXT) = CAST(s.table_id AS TEXT)
        WHERE oi.status IN ('ordered', 'cooking', 'ready', 'cancelled', 'served') AND LOWER(TRIM(s.status)) = 'active'
        GROUP BY t.table_id, t.table_number
        ORDER BY CAST(t.table_number AS INTEGER) ASC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Error fetching status tables:', err.message);
            return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลโต๊ะ');
        }

        res.render('kitchen', { bills: [], dishes: [], tables: rows || [], msg: '', mode: 'tables', page: 'status', title: 'อัพเดทสถานะอาหาร' });
    });
});

// 8.5 หน้ารายละเอียดรายโต๊ะ (แยก 4 กอง: รอรับ กำลังปรุง พร้อมเสิร์ฟ ยกเลิกแล้ว)
app.get('/kitchen/table/:table_id', (req, res) => {
    const tableId = req.params.table_id;
    const rawMsg = String(req.query.msg || '');
    const msg = KITCHEN_MSG.includes(rawMsg) ? rawMsg : '';
    // จำหน้ามาเพื่อไฮไลต์แท็บและปุ่มกลับให้ถูก (kitchen / status / orders)
    const rawFrom = String(req.query.from || '');
    const fromPage = ['kitchen', 'status', 'orders'].includes(rawFrom) ? rawFrom : 'status';
    const backUrl = fromPage === 'kitchen' ? '/kitchen' : (fromPage === 'orders' ? '/orders' : '/kitchen/status');
    const backText = fromPage === 'kitchen' ? 'กลับหน้าครัว' : (fromPage === 'orders' ? 'กลับหน้ารายละเอียด' : 'กลับหน้าอัพเดท');

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

            res.render('kitchen-detail', { table: tableInfo, ordered: ordered, cooking: cooking, ready: ready, served: served, cancelled: cancelled, msg: msg, page: (fromPage === 'orders' ? '' : fromPage), backUrl: backUrl, backText: backText });
        });
    });
});

// 8.6 เปลี่ยนสถานะรายจาน (ครัว: cooking <-> ready / เสิร์ฟ: ready -> served / ยกเลิก: ต้องมีเหตุผล)
app.post('/kitchen/item/:id/status', (req, res) => {
    const itemId = Number(req.params.id);
    const to = String(req.body.to || '');
    const tableId = String(req.body.table_id || '');
    const backTo = /^[0-9]+$/.test(tableId) ? '/kitchen/table/' + tableId : '/kitchen';
    // หน้าที่กดปุ่มมา (ให้เด้งกลับหน้านั้น): รายละเอียดเสิร์ฟ หรือ ออเดอร์ที่ต้องทำ
    const BACK_OK = ['/orders', '/kitchen/ordered'];
    const rawBack = String(req.body.back || '');
    const homeBack = BACK_OK.includes(rawBack) ? rawBack : null;
    const backWithMsg = (key) => (homeBack || backTo) + ((homeBack || backTo).includes('?') ? '&' : '?') + 'msg=' + key;

    // ยกเลิกต้องพิมพ์เหตุผลมาด้วย (เสิร์ฟแล้วห้ามยกเลิก)
    const isCancel = (to === ST.CANCELLED);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    let stepMap = null;
    if (Object.prototype.hasOwnProperty.call(KITCHEN_STEP, to)) stepMap = KITCHEN_STEP;
    else if (Object.prototype.hasOwnProperty.call(SERVE_STEP, to)) stepMap = SERVE_STEP;
    if (!Number.isInteger(itemId) || itemId <= 0) {
        return res.redirect(backWithMsg('invalid'));
    }
    if (isCancel && reason === '') {
        return res.redirect(backWithMsg('invalid'));
    }
    if (!isCancel && !stepMap) {
        return res.redirect(backWithMsg('invalid'));
    }

    db.get("SELECT employee_id FROM EMPLOYEES WHERE role = 'kitchen' LIMIT 1", [], (err, emp) => {
        if (err || !emp) {
            console.error('Error finding kitchen employee:', err ? err.message : 'not found');
            return res.status(500).send('เกิดข้อผิดพลาดในการอัปเดตสถานะอาหาร');
        }

        // ตอบกลับเหมือนกันทั้งสองทาง: ไม่เปลี่ยนแถว = สถานะไม่ตรงแล้ว
        const afterUpdate = function (err) {
            if (err) {
                console.error('Error updating kitchen item status:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการอัปเดตสถานะอาหาร');
            }
            if (this.changes === 0) {
                return res.redirect(backWithMsg('changed'));
            }
            res.redirect(homeBack || backTo);
        };

        if (isCancel) {
            db.run("UPDATE ORDER_ITEMS SET status = 'cancelled', cancel_reason = ?, updated_by_employee_id = ? WHERE order_item_id = ? AND status IN ('ordered', 'cooking', 'ready')",
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
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
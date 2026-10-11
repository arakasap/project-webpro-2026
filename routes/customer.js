const express = require('express');
const { isBillableOrderItem } = require('../utils/order-billing');

function createCustomerRouter({ db, cartHelpers }) {
    const router = express.Router();
    const {
        buildSessionCartKey,
        getSessionCartStore,
        getSessionCartState,
        addSessionCartItem,
        removeSessionCartItem,
        getSessionCartSnapshot
    } = cartHelpers;

    router.get('/', (req, res) => {
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

    router.post('/join-session', (req, res) => {
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
    router.get('/menu', (req, res) => {
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
    router.get('/order-status', (req, res) => {
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
    router.get('/table-summary', (req, res) => {
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
                                if (!isBillableOrderItem(item)) return total;
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
                                    if (!isBillableOrderItem(item)) return;

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

    router.get('/owner-summary', (req, res) => {
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
                                            if (!isBillableOrderItem(item)) return total;
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

    router.post('/api/order-items/:id/owners', (req, res) => {
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
    router.post('/order/add', (req, res) => {
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
    router.post('/api/add-user', (req, res) => {
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
    router.get('/cart', (req, res) => {
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

    router.put('/api/cart/item/:id', (req, res) => {
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
    router.post('/api/orders/confirm-from-session', (req, res) => {
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
    router.post('/api/orders/send-to-kitchen', (req, res) => {
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
    router.delete('/api/cart/item/:id', (req, res) => {
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

    router.post('/order/item/delete', (req, res) => {
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
    router.delete('/resetdatabase', (req, res) => {
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

    return router;
}

module.exports = createCustomerRouter;

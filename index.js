const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log('Connected to SQLite database.');
});

// 1. หน้าต้อนรับ
// 1. หน้าต้อนรับ
app.get('/', (req, res) => {
    const sessionId = req.query.session_id || 1;

    // ดึงรายชื่อผู้ใช้ที่เคยเข้ามาใน session นี้แล้ว เพื่อมาแสดงใน dropdown
    db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [sessionId], (err, existingUsers) => {
        if (err) existingUsers = [];

        res.render('index', {
            sessionId: sessionId,
            shopName: "ไอทีม่วนแจ่ม",
            existingUsers: existingUsers, // ส่งรายชื่อผู้ใช้เดิมไปแสดง
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

    // กำหนด table_id (ถ้าไม่มีให้ใช้ session_id หรือค่าเริ่มต้นเป็น 1)
    const targetTableId = table_id || session_id || 1;

    // 1. ตรวจสอบ/สร้างข้อมูลโต๊ะในตาราง TABLES ก่อนเพื่อป้องกัน Foreign Key Error
    const ensureTableSql = `INSERT OR IGNORE INTO TABLES (table_id, table_number, status) VALUES (?, ?, 'AVAILABLE')`;

    db.run(ensureTableSql, [targetTableId, String(targetTableId)], (err) => {
        if (err) console.log('Ensure table notice:', err.message);

        // 2. ค้นหา Session ที่กำลังใช้งาน (active) ของโต๊ะนี้
        db.get('SELECT session_id FROM SESSIONS WHERE table_id = ? AND status = "active"', [targetTableId], (err, activeSession) => {
            if (err) {
                console.error('Error checking active session:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบ Session');
            }

            // ฟังก์ชันสำหรับบันทึกชื่อผู้ใช้ลง SESSION_USERS
            const saveUserAndRedirect = (sessionIdToUse) => {
                const sqlUser = `INSERT INTO SESSION_USERS (session_id, name) VALUES (?, ?)`;
                db.run(sqlUser, [sessionIdToUse, name.trim()], function (err) {
                    if (err) {
                        console.error('Error saving user:', err.message);
                        return res.status(500).send('เกิดข้อผิดพลาดในการบันทึกข้อมูลผู้ใช้');
                    }
                    // Redirect พร้อม session_id และ user_id
                    res.redirect(`/menu?session_id=${sessionIdToUse}&user_id=${this.lastID}`);
                });
            };

            if (activeSession) {
                // มี Session เดิมเปิดอยู่แล้ว ใช้ session_id นั้นต่อได้เลย
                saveUserAndRedirect(activeSession.session_id);
            } else {
                // ถ้ายังไม่มี Session ให้สร้างใหม่ลงในตาราง SESSIONS
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

// 3. หน้าแสดงรายการอาหาร (Menu Page)
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

// 4. รับฟอร์มกดเพิ่มรายการอาหารลงตะกร้า (status = 'pending')
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

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND status = "active"', [session_id], (err, order) => {
        if (err) return res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบออเดอร์');

        const insertOrderItem = (orderId) => {
            const sqlItem = `INSERT INTO ORDER_ITEMS (order_id, menu_item_id, qty, note, status) VALUES (?, ?, ?, ?, 'pending')`;
            
            db.run(sqlItem, [orderId, menu_item_id, itemQty, note || ''], function (err) {
                if (err) return res.status(500).send('ไม่สามารถเพิ่มรายการอาหารได้');

                const orderItemId = this.lastID;
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

    const sql = `INSERT INTO SESSION_USERS (session_id, name) VALUES (?, ?)`;
    db.run(sql, [session_id || 1, name.trim()], function (err) {
        if (err) return res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
        
        res.json({
            user_id: this.lastID,
            name: name.trim()
        });
    });
});

// 5. หน้าแสดงตะกร้าสินค้า (ดึงเฉพาะรายการที่ User ปัจจุบันเป็นคนสั่งและยังไม่ส่งเข้าครัว)
app.get('/cart', (req, res) => {
    const { session_id, user_id } = req.query;

    if (!session_id || !user_id) {
        return res.redirect('/');
    }

    db.get('SELECT * FROM SESSION_USERS WHERE user_id = ?', [user_id], (err, currentUser) => {
        if (err || !currentUser) return res.redirect('/');

        db.all('SELECT * FROM SESSION_USERS WHERE session_id = ?', [session_id], (err, sessionUsers) => {
            if (err) sessionUsers = [];

            db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND status = "active"', [session_id], (err, order) => {
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

                // ดึงรายการอาหารทั้งหมดในโต๊ะที่ยังรอส่งเข้าครัว (status = 'pending')
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

                        // ตรวจสอบว่าผู้ใช้ปัจจุบันมีส่วนหารในรายการนี้หรือไม่
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

// 6. API ยืนยันออร์เดอร์ส่งเข้าครัว (เปลี่ยน status จาก 'pending' -> 'cooking')
app.post('/api/orders/send-to-kitchen', (req, res) => {
    const { tableNo, userId } = req.body;
    const sessionId = tableNo;

    db.get('SELECT order_id FROM ORDERS WHERE session_id = ? AND status = "active"', [sessionId], (err, order) => {
        if (err || !order) {
            return res.status(400).json({ success: false, message: 'ไม่พบออเดอร์ที่เปิดใช้งานอยู่' });
        }

        // อัปเดตสถานะเป็น 'cooking' เฉพาะรายการที่เป็นของ user คนนี้ และยังคงสถานะ 'pending' อยู่
        const sqlUpdate = `
            UPDATE ORDER_ITEMS 
            SET status = 'cooking' 
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

// 7. ลบรายการอาหารในตะกร้า (AJAX & Form Response)
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

app.delete('/resetdatabase', (req, res) => {
    // 1. คำสั่ง SQL สำหรับล้างข้อมูล
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

        // 2. ตรวจสอบว่าในตาราง TABLES มีข้อมูลโต๊ะอยู่หรือไม่
        db.get('SELECT table_id FROM TABLES LIMIT 1', [], (err, tableRow) => {
            
            // ฟังก์ชันสำหรับสร้าง Session ใหม่เมื่อมี table_id ที่ถูกต้องแล้ว
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
                // กรณีมีข้อมูลโต๊ะในตาราง TABLES อยู่แล้ว ให้ใช้ table_id นั้น
                createSession(tableRow.table_id);
            } else {
                // กรณีไม่มีข้อมูลในตาราง TABLES เลย ให้สร้างโต๊ะ 1 ขึ้นมาก่อน
                const defaultTableId = req.body?.table_id || req.query?.table_id || 1;
                
                db.run(`INSERT INTO TABLES (table_id, status) VALUES (?, 'AVAILABLE')`, [defaultTableId], function (err) {
                    if (err) {
                        // หากใส่ table_id ไม่ได้ ให้ลอง INSERT แบบ auto-increment
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

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
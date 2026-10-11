const express = require('express');

function createKitchenRouter({ db }) {
    const router = express.Router();

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
    router.get('/kitchen', (req, res) => {
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
    router.post('/kitchen/accept', (req, res) => {
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
    router.get(['/kitchen/ordered', '/kitchen/orders'], (req, res) => {
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
    router.get('/kitchen/status', (req, res) => {
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

    router.get('/kitchen/table', (req, res) => {
        res.redirect('/kitchen/orders');
    });

    // 8.5 หน้ารายละเอียดรายโต๊ะ (แยก 4 กอง: รอรับ กำลังปรุง พร้อมเสิร์ฟ ยกเลิกแล้ว)
    router.get('/kitchen/table/:table_id', (req, res) => {
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
    router.post('/kitchen/item/:id/status', (req, res) => {
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
    router.get('/orders', (req, res) => {
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

    return router;
}

module.exports = createKitchenRouter;

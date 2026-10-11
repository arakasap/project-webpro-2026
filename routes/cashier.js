const express = require('express');
const { BILLABLE_ORDER_ITEM_SQL } = require('../utils/order-billing');

function createCashierRouter({ db, promptpayNo }) {
    const router = express.Router();
    const PROMPTPAY_NO = promptpayNo;

    router.get('/cashier', (req, res) => {
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
    router.get('/cashier/table/:table_id', (req, res) => {
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
                    WHERE o.session_id = ? AND ${BILLABLE_ORDER_ITEM_SQL}
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
    router.get('/cashier/table/:table_id/payment', (req, res) => {
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
                    WHERE o.session_id = ? AND ${BILLABLE_ORDER_ITEM_SQL}
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
    router.post('/cashier/table/:table_id/toggle-user-paid', (req, res) => {
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
    router.post('/cashier/table/:table_id/finish-payment', (req, res) => {
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
                                 WHERE o.session_id = ? AND ${BILLABLE_ORDER_ITEM_SQL}
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

    return router;
}

module.exports = createCashierRouter;

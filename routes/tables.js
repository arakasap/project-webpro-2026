const express = require('express');
const QRCode = require('qrcode');

module.exports = function createTablesRouter({ db }) {
    const router = express.Router();

    router.get('/tables', (req, res) => {
        const query = 'SELECT * FROM tables ORDER BY table_id ASC';

        db.all(query, [], async (err, rows) => {
            if (err) {
                console.error('DB Error:', err.message);
                return res.status(500).send('เกิดข้อผิดพลาดในการดึงข้อมูลโต๊ะ');
            }

            try {
                const baseUrl = `${req.protocol}://${req.get('host')}`;

                const tablesWithQr = await Promise.all(
                    rows.map(async (table) => {
                        const targetId = table.table_id || table.id;
                        const tableUrl = `${baseUrl}/table/${targetId}`;
                        const qrCode = await QRCode.toDataURL(tableUrl);
                        return { ...table, qrCode };
                    })
                );

                res.render('tables', { tables: tablesWithQr });
            } catch (qrError) {
                console.error('QR Generator Error:', qrError);
                res.status(500).send('เกิดข้อผิดพลาดในการสร้าง QR Code');
            }
        });
    });

    return router;
};
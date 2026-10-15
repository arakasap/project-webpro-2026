const { createCanvas } = require('@napi-rs/canvas');

const CANVAS_WIDTH = 640;
const HORIZONTAL_PADDING = 44;
const CONTENT_WIDTH = CANVAS_WIDTH - HORIZONTAL_PADDING * 2;
const THAI_SEGMENTER = new Intl.Segmenter('th', { granularity: 'word' });

function wrapText(context, text, maxWidth) {
    const segments = [...THAI_SEGMENTER.segment(String(text))]
        .map(({ segment }) => segment);
    const lines = [];
    let line = '';

    for (const segment of segments) {
        const candidate = line + segment;
        if (line && context.measureText(candidate).width > maxWidth) {
            lines.push(line.trimEnd());
            line = segment.trimStart();
            continue;
        }

        if (!line && context.measureText(segment).width > maxWidth) {
            let fragment = '';
            for (const character of Array.from(segment)) {
                if (fragment && context.measureText(fragment + character).width > maxWidth) {
                    lines.push(fragment);
                    fragment = character;
                } else {
                    fragment += character;
                }
            }
            line = fragment;
        } else {
            line = candidate;
        }
    }

    if (line.trim()) lines.push(line.trimEnd());
    return lines.length > 0 ? lines : [''];
}

function formatMoney(value) {
    return (Number(value) || 0).toLocaleString('th-TH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '-');

    return date.toLocaleString('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short'
    });
}

function renderReceiptPng({ session, items, payments, total, isPaid }) {
    const estimatedHeight = 700
        + items.reduce((height, item) => height + Array.from(String(item.name || '')).length * 28 + 120, 0)
        + payments.reduce((height, payment) => height + Array.from(String(payment.payer_name || '')).length * 26 + 90, 0);
    const canvas = createCanvas(CANVAS_WIDTH, estimatedHeight);
    const context = canvas.getContext('2d');
    const left = HORIZONTAL_PADDING;
    const right = CANVAS_WIDTH - HORIZONTAL_PADDING;
    const center = CANVAS_WIDTH / 2;
    let y = 38;

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, CANVAS_WIDTH, canvas.height);
    context.fillStyle = '#17251c';
    context.textBaseline = 'top';
    context.textAlign = 'center';

    context.strokeStyle = '#166534';
    context.lineWidth = 3;
    context.strokeRect(center - 17, y, 34, 38);
    context.beginPath();
    context.moveTo(center - 9, y + 12);
    context.lineTo(center + 9, y + 12);
    context.moveTo(center - 9, y + 20);
    context.lineTo(center + 9, y + 20);
    context.moveTo(center - 9, y + 28);
    context.lineTo(center + 3, y + 28);
    context.stroke();
    y += 54;

    context.fillStyle = '#17251c';
    context.font = '32px monospace';
    context.fillText('ไอทีม่วนแจ่ม', center, y);
    y += 43;

    context.fillStyle = '#166534';
    context.font = '24px monospace';
    context.fillText(isPaid ? 'ใบเสร็จรับเงิน' : 'สรุปการชำระเงิน', center, y);
    y += 36;

    context.fillStyle = '#526257';
    context.font = '17px monospace';
    context.fillText(`เลขที่รายการ ${session.session_id}`, center, y);
    y += 35;
    y = drawSeparator(context, left, right, y);

    y = drawMetaRow(context, 'โต๊ะ', String(session.table_number), left, right, y);
    y = drawMetaRow(context, 'วันที่', formatDate(session.issued_at), left, right, y);
    context.fillStyle = isPaid ? '#166534' : '#92400e';
    context.font = '18px monospace';
    context.textAlign = 'right';
    context.fillText(isPaid ? 'ชำระครบแล้ว' : 'มียอดรอชำระ', right, y);
    context.fillStyle = '#526257';
    context.textAlign = 'left';
    context.font = '18px monospace';
    context.fillText('สถานะ', left, y);
    y += 36;
    y = drawSeparator(context, left, right, y);

    context.fillStyle = '#526257';
    context.font = '17px monospace';
    context.textAlign = 'left';
    context.fillText('รายการ', left, y);
    y += 30;

    if (items.length === 0) {
        context.fillStyle = '#526257';
        context.font = '17px monospace';
        context.fillText('ไม่มีรายการอาหารในบิลนี้', left, y);
        y += 32;
    } else {
        items.forEach((item) => {
            const nameLines = wrapText(context, item.name, 330);
            const rowStart = y;

            context.fillStyle = '#17251c';
            context.font = '18px monospace';
            context.textAlign = 'left';
            nameLines.forEach((line, index) => {
                context.fillText(line, left, rowStart + index * 25);
            });

            context.fillStyle = '#526257';
            context.font = '15px monospace';
            context.fillText(`${formatMoney(item.price)} บาท/รายการ`, left, rowStart + nameLines.length * 25);

            context.fillStyle = '#17251c';
            context.font = '17px monospace';
            context.textAlign = 'center';
            context.fillText(`× ${item.qty}`, 454, rowStart + 1);

            context.textAlign = 'right';
            context.font = '17px monospace';
            context.fillText(formatMoney(item.lineTotal), right, rowStart + 1);
            y += nameLines.length * 25 + 48;
        });
    }

    y = drawSeparator(context, left, right, y);
    context.fillStyle = '#17251c';
    context.textAlign = 'left';
    context.font = '700 19px monospace';
    context.fillText('ยอดรวมสุทธิ', left, y + 1);
    context.textAlign = 'right';
    context.font = '700 28px monospace';
    context.fillText(`${formatMoney(total)} บาท`, right, y - 4);
    y += 49;
    y = drawSeparator(context, left, right, y);

    context.fillStyle = '#526257';
    context.textAlign = 'left';
    context.font = '700 17px monospace';
    context.fillText('การชำระเงิน', left, y);
    y += 31;

    if (payments.length === 0) {
        context.fillStyle = '#526257';
        context.font = '400 17px monospace';
        context.fillText('ไม่พบข้อมูลการชำระเงิน', left, y);
        y += 32;
    } else {
        payments.forEach((payment) => {
            const payerLines = wrapText(context, payment.payer_name, 360);
            const rowStart = y;

            context.fillStyle = '#17251c';
            context.textAlign = 'left';
            context.font = '600 17px monospace';
            payerLines.forEach((line, index) => {
                context.fillText(line, left, rowStart + index * 24);
            });

            context.fillStyle = '#526257';
            context.font = '400 15px monospace';
            context.fillText(
                `${payment.method} · ${String(payment.status).toLowerCase() === 'paid' ? 'ชำระแล้ว' : 'รอชำระ'}`,
                left,
                rowStart + payerLines.length * 24
            );

            context.fillStyle = '#17251c';
            context.textAlign = 'right';
            context.font = '600 17px monospace';
            context.fillText(formatMoney(payment.amount), right, rowStart + 1);
            y += payerLines.length * 24 + 40;
        });
    }

    y = drawSeparator(context, left, right, y);
    context.fillStyle = '#166534';
    context.textAlign = 'center';
    context.font = '700 20px monospace';
    context.fillText('ขอบคุณที่อุดหนุน', center, y + 18);
    y += 56;

    context.fillStyle = '#526257';
    context.font = '400 13px monospace';
    context.fillText('ไอทีม่วนแจ่ม · RECEIPT', center, y);

    const output = createCanvas(CANVAS_WIDTH, y + 48);
    output.getContext('2d').drawImage(canvas, 0, 0);
    return output.toBuffer('image/png');
}

function drawMetaRow(context, label, value, left, right, y) {
    context.textBaseline = 'top';
    context.textAlign = 'left';
    context.font = '400 18px monospace';
    context.fillStyle = '#526257';
    context.fillText(label, left, y);
    context.textAlign = 'right';
    context.font = '600 18px monospace';
    context.fillStyle = '#17251c';

    const valueLines = wrapText(context, value, CONTENT_WIDTH - 100);
    valueLines.forEach((line, index) => {
        context.fillText(line, right, y + index * 24);
    });

    return y + Math.max(36, valueLines.length * 24 + 8);
}

function drawSeparator(context, left, right, y) {
    context.save();
    context.strokeStyle = '#a9b8ac';
    context.lineWidth = 1;
    context.setLineDash([4, 7]);
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.restore();
    return y + 23;
}

module.exports = { renderReceiptPng };

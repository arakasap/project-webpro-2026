---
name: restaurant-ordering-system
description: Conventions and tech stack for building the Isaan restaurant ordering system project (ระบบสั่งอาหารร้านอาหารอีสาน). Use this skill whenever writing, editing, or reviewing code for this project — including backend routes, frontend pages, database queries, or real-time order/status features. Covers the required stack (plain Node.js + HTML/CSS + Tailwind, no frontend framework), folder structure, database (MySQL), and the split-bill data model. Always consult this before creating new files or suggesting a different stack.
---

# Restaurant Ordering System — Project Conventions

โปรเจค: ระบบสั่งอาหารร้านอาหารอีสาน (Information System Analysis and Design, 06066304)

## Tech Stack (Final Decision)

ห้ามเสนอ framework อื่นแทน เว้นแต่ผู้ใช้ขอเปลี่ยนเอง:

| Layer | เทคโนโลยี |
|---|---|
| Frontend | **Plain HTML + CSS + Tailwind CSS** (ไม่ใช้ React/Next.js/Vue) |
| Backend | **Node.js + Express** |
| Database | **SQLite** |
| Real-time | **Socket.io** (สถานะอาหาร: รอรับ → กำลังปรุง → พร้อมเสิร์ฟ) |
| ORM/Query | ใช้ `mysql2` driver ตรงๆ หรือ Prisma ถ้าต้องการ type safety — ถามผู้ใช้ก่อนถ้ายังไม่ตกลง |
| Templating | ใช้ EJS หรือ vanilla JS fetch() ต่อ API แล้ว render ฝั่ง client ก็ได้ — ไม่ต้องมี build step ที่ซับซ้อน |

**เหตุผลที่เลือก stack นี้:** ทีมต้องการความง่าย ไม่ต้องตั้ง build pipeline/bundler ซับซ้อน (ตัดสินใจเปลี่ยนจาก Next.js/React มาเป็น plain stack เพื่อลด dependency และเรียนรู้ fundamentals ตรงๆ)

## โครงสร้างโฟลเดอร์ที่แนะนำ

```
project-root/
├── server.js                 # Express + Socket.io entry point
├── config/
│   └── db.js                 # MySQL connection pool
├── routes/
│   ├── customer.js           # ลูกค้า: เมนู, สั่งอาหาร, แยกบิล
│   ├── kitchen.js             # พนักงานครัว: รับออเดอร์, อัปเดตสถานะ
│   ├── server-staff.js        # พนักงานเสิร์ฟ
│   └── cashier.js            # พนักงานแคชเชียร์: สรุปยอด, ชำระเงิน
├── public/
│   ├── css/                  # Tailwind output (compiled)
│   ├── js/                   # vanilla JS ฝั่ง client + socket.io-client
│   └── views/                # HTML pages แยกตาม actor
│       ├── customer/
│       ├── kitchen/
│       ├── server/
│       └── cashier/
├── sql/
│   └── schema.sql            # CREATE TABLE ทั้งหมด
└── package.json
```

## Database Schema (MySQL)

ตารางหลักตาม ER Diagram ที่สรุปแล้ว:

- `tables` — โต๊ะอาหาร (table_id, table_number, status)
- `sessions` — รอบมื้อของโต๊ะ (session_id, table_id, status, created_at)
- `session_users` — คนในโต๊ะ ไม่ต้อง login จริง (user_id, session_id, name)
- `categories` — หมวดหมู่เมนู แยกตารางเพื่อกันพิมพ์ชื่อไม่ตรงกัน (category_id, name)
- `menu_items` — เมนูอาหาร (menu_item_id, category_id FK, name, price, image_url, is_available)
- `orders` — คำสั่งซื้อของ session (order_id, session_id, status, created_at)
- `order_items` — รายการอาหารที่สั่ง (order_item_id, order_id, menu_item_id, updated_by_employee_id, qty, note, status)
- `order_item_owners` — **ตารางหัวใจของการแยกบิล** many-to-many ระหว่าง order_items กับ session_users (1 จานแชร์ได้หลายคน, 1 คนรับผิดชอบได้หลายจาน)
- `employees` — พนักงาน (employee_id, name, role) — เก็บไว้เพื่อ audit trail เท่านั้น ไม่มีระบบ login เต็มรูปแบบ
- `payments` — การชำระเงิน (payment_id, session_id, user_id, processed_by_employee_id, amount, method, status, slip_ref, paid_at)

### หลักการสำคัญ: อะไรเก็บ DB vs อะไรคำนวณสด

**ต้องเก็บ (input ดิบ, ไม่มีสูตรคำนวณย้อนกลับได้):**
- `order_item_owners` — ใครรับผิดชอบจานไหน เป็นการตัดสินใจของลูกค้า
- `payments` — ประวัติการชำระเงิน ต้องมีไว้ทำ reconciliation และออกใบเสร็จ

**คำนวณสดได้ (derived, ไม่ต้อง materialize):**
- ยอดรวมที่แต่ละคนต้องจ่าย = คำนวณจาก `order_items` × `order_item_owners` ตอน query
- ยอดรวมทั้งโต๊ะ

**ข้อยกเว้น:** ตอนลูกค้ากดเข้าสู่ขั้นตอนชำระเงินจริง ให้ freeze ยอดที่คำนวณได้ลงใน `payments.amount` ทันที (snapshot) เพื่อกัน race condition กรณีมีคนสั่งเพิ่มระหว่างที่อีกคนกำลังจ่ายพอดี

## Actors ในระบบ (ตาม Use Case Diagram)

4 actor หลัก ไม่มีขั้นตอน login ของพนักงาน (1 อุปกรณ์ = 1 บทบาท):

1. **ลูกค้า** — สแกน QR Code ต่อโต๊ะ, ใช้อุปกรณ์ของตัวเอง (BYOD), ไม่ต้องติดตั้งแอป
2. **พนักงานครัว** — รับออเดอร์ real-time, อัปเดตสถานะอาหาร
3. **พนักงานเสิร์ฟ** — ดูรายละเอียดคำสั่งซื้อ, อัปเดตสถานะเสิร์ฟ
4. **พนักงานแคชเชียร์** — สรุปยอดต่อโต๊ะ, รับชำระเงิน (รวม/แยกบิล), พิมพ์ใบเสร็จ

## Real-time Requirements

ใช้ Socket.io broadcast เมื่อ:
- ลูกค้ายืนยันคำสั่งซื้อ → แจ้งพนักงานครัวทันที
- พนักงานครัวเปลี่ยนสถานะอาหาร (กำลังปรุง/พร้อมเสิร์ฟ) → อัปเดตหน้าจอลูกค้าและเสิร์ฟทันที
- มีการชำระเงิน → อัปเดตสถานะโต๊ะที่จอแคชเชียร์

## สิ่งที่ต้องระวังเมื่อเขียนโค้ดให้โปรเจคนี้

- **อย่าใส่ React/JSX/Next.js syntax** แม้จะดูสะดวกกว่า — ผู้ใช้ตัดสินใจแล้วว่าจะใช้ plain stack
- ฝั่ง client ใช้ vanilla `fetch()` และ DOM manipulation ธรรมดา หรือ Alpine.js ถ้าต้องการ reactivity เบาๆ (ต้องถามก่อนเพิ่ม dependency ใหม่)
- Tailwind ต้อง build ผ่าน Tailwind CLI หรือ PostCSS ธรรมดา ไม่ใช้ CDN play script ใน production
- ทุก query ที่เกี่ยวกับเงิน (`payments`, การคำนวณยอด) ต้องใช้ MySQL transaction (`START TRANSACTION` / `COMMIT`) เพื่อกันข้อมูลไม่ตรงกันตอนมีคนกดพร้อมกัน
- PDPA: เก็บชื่อลูกค้าใน `session_users` แบบชั่วคราวตาม session เท่านั้น ไม่เก็บถาวรหลังปิดบิล เว้นแต่จะออกแบบระบบสมาชิกเพิ่มในอนาคต

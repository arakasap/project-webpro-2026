---
name: restaurant-ordering-system
description: Conventions and tech stack for building the Isaan restaurant ordering system project (ระบบสั่งอาหารร้านอาหารอีสาน). Use this skill whenever writing, editing, or reviewing code for this project — including backend logic, frontend pages, database queries, and order/status flows. Covers the required stack (plain Node.js + HTML/CSS + Tailwind, no frontend framework, no Socket.io), a single-file backend structure centered on index.js, database (SQLite), and the split-bill data model. Always consult this before creating new files or suggesting a different stack.
---

# Restaurant Ordering System — Project Conventions

โปรเจค: ระบบสั่งอาหารร้านอาหารอีสาน (Information System Analysis and Design, 06066304)

## Tech Stack (Final Decision)

ห้ามเสนอ framework อื่นแทน เว้นแต่ผู้ใช้ขอเปลี่ยนเอง:

| Layer | เทคโนโลยี |
|---|---|
| Frontend | **Plain HTML + CSS + Tailwind CSS** (ไม่ใช้ React/Next.js/Vue) |
| Backend | **Node.js + Express** ในไฟล์หลักเดียว [project-webpro-2026/index.js](project-webpro-2026/index.js) |
| Database | **SQLite** |
| Real-time | **ไม่ใช้ Socket.io** — ใช้ refresh หน้า / polling หรือการอัปเดตแบบธรรมดาแทน |
| ORM/Query | ใช้ SQLite driver ตรงๆ และ SQL query อย่างชัดเจน ไม่ต้องมี ORM หรือ Prisma โดยปริยาย |
| Templating | ใช้ EJS หรือ vanilla JS fetch() ต่อ API แล้ว render ฝั่ง client ก็ได้ — ไม่ต้องมี build step ที่ซับซ้อน |

**เหตุผลที่เลือก stack นี้:** ทีมต้องการความง่าย ไม่ต้องตั้ง build pipeline/bundler ซับซ้อน และต้องหลีกเลี่ยงความซับซ้อนของ real-time framework เช่น Socket.io โดยเก็บทุกอย่างของ backend ไว้ในไฟล์หลักเดียวเพื่อให้ง่ายต่อดูและแก้ไข

## โครงสร้างโฟลเดอร์ที่แนะนำ

```
project-root/
├── index.js                 # Express backend หลัก; เก็บ route, logic, query, service, middleware ไว้ที่นี่
├── public/
│   ├── css/                 # Tailwind output (compiled) หรือ custom CSS
│   ├── js/                  # vanilla JS ฝั่ง client
│   └── views/               # HTML/EJS pages แยกตาม actor
│       ├── customer/
│       ├── kitchen/
│       ├── server/
│       └── cashier/
├── database.db             # SQLite database file
├── sql/
│   └── schema.sql           # CREATE TABLE ทั้งหมด
├── package.json
└── README.md
```

**กฎสำคัญ:** Backend ต้องไม่แยกไฟล์ route หรือ controller เป็นหลายไฟล์ในโครงสร้างทั่วไป หากต้องแยกย่อย ให้แยกเฉพาะสิ่งที่เข้าข่าย helper หรือ utility เท่านั้น และ still keep core server logic in index.js เป็นหลัก

## Database Schema (SQLite)

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

## Real-time / Status Update Requirements

โปรเจคนี้ต้องไม่ใช้ Socket.io และไม่ใช้ WebSocket framework ใดๆ ทุกประการ:
- ลูกค้ายืนยันคำสั่งซื้อ → อัปเดตสถานะผ่าน refresh หน้า หรือ fetch ใหม่จาก server
- พนักงานครัวเปลี่ยนสถานะอาหาร (กำลังปรุง/พร้อมเสิร์ฟ) → อัปเดตสถานะด้วยการ reload หน้า หรือ polling ตามความเหมาะสม
- มีการชำระเงิน → อัปเดตสถานะโต๊ะโดย refresh หรือ fetch การ์ดข้อมูลอีกครั้ง

## สิ่งที่ต้องระวังเมื่อเขียนโค้ดให้โปรเจคนี้

- **อย่าใส่ React/JSX/Next.js syntax** แม้จะดูสะดวกกว่า — ผู้ใช้ตัดสินใจแล้วว่าจะใช้ plain stack
- ฝั่ง client ใช้ vanilla `fetch()` และ DOM manipulation ธรรมดา หรือ Alpine.js ถ้าต้องการ reactivity เบาๆ (ต้องถามก่อนเพิ่ม dependency ใหม่)
- Tailwind ต้อง build ผ่าน Tailwind CLI หรือ PostCSS ธรรมดา ไม่ใช้ CDN play script ใน production
- ทุก query ที่เกี่ยวกับเงิน (`payments`, การคำนวณยอด) ต้องใช้ SQLite transaction (`BEGIN TRANSACTION` / `COMMIT`) เพื่อกันข้อมูลไม่ตรงกันตอนมีคนกดพร้อมกัน
- PDPA: เก็บชื่อลูกค้าใน `session_users` แบบชั่วคราวตาม session เท่านั้น ไม่เก็บถาวรหลังปิดบิล เว้นแต่จะออกแบบระบบสมาชิกเพิ่มในอนาคต

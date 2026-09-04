# Hướng dẫn cài đặt & chạy bot

Bot theo dõi ví "dev tạo memecoin" trên Robinhood Chain. Chọn đúng hệ điều
hành của bạn bên dưới và làm theo thứ tự — không cần biết lập trình, chỉ
cần copy/paste đúng lệnh vào Terminal (Mac) hoặc PowerShell (Windows).

---

## 🍎 macOS

### Bước 1 — Cài Homebrew (nếu máy chưa có)

Mở **Terminal** (tìm trong Spotlight: nhấn `Cmd + Space`, gõ "Terminal"),
dán lệnh sau rồi Enter:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Làm theo hướng dẫn trên màn hình (nhập mật khẩu máy Mac khi được hỏi — gõ
không hiện ký tự gì là bình thường). Cuối cùng nó sẽ in ra 2-3 dòng lệnh
yêu cầu chạy thêm — copy đúng các dòng đó và chạy.

Kiểm tra cài xong chưa:
```bash
brew --version
```

### Bước 2 — Cài Node.js, Postgres, Redis

```bash
brew install node postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

### Bước 3 — Tạo database

```bash
createdb robinhood_tracker
```

### Bước 4 — Giải nén và cài đặt project

Giải nén file zip này ra (double-click vào file `.zip`), sau đó trong
Terminal, `cd` vào đúng thư mục vừa giải nén. Cách dễ nhất: gõ `cd ` (có
dấu cách sau chữ cd), rồi **kéo thả thư mục vừa giải nén từ Finder vào
cửa sổ Terminal**, nhấn Enter.

```bash
npm install
cp .env.example .env
open -e .env
```

Trong file `.env` vừa mở, sửa dòng:
```
DATABASE_URL=postgresql://<username_mac_của_bạn>@localhost:5432/robinhood_tracker
```
(chạy lệnh `whoami` trong Terminal để lấy đúng username). Lưu file (Cmd+S).

### Bước 5 — Khởi tạo database và chạy bot

```bash
npm run db:migrate
npm run dev
```

Mở trình duyệt vào **http://localhost:3000** — xong!

Dừng bot: quay lại Terminal, nhấn `Ctrl + C`.

---

## 🪟 Windows

### Bước 1 — Cài Node.js

Vào https://nodejs.org, tải bản **LTS**, chạy file cài đặt, bấm Next liên
tục tới khi xong (giữ nguyên mặc định).

Kiểm tra: mở **PowerShell** (nhấn phím Windows, gõ "PowerShell", Enter),
gõ:
```powershell
node --version
```

### Bước 2 — Cài Docker Desktop (để chạy Postgres + Redis dễ nhất)

Vào https://www.docker.com/products/docker-desktop, tải và cài đặt cho
Windows. Sau khi cài xong, **mở ứng dụng Docker Desktop lên** (để nó chạy
nền — icon cá voi ở khay hệ thống góc dưới phải màn hình). Nếu được hỏi
bật WSL2, đồng ý theo hướng dẫn trên màn hình.

### Bước 3 — Giải nén project

Chuột phải vào file `.zip` → **Extract All...** → chọn nơi giải nén (ví dụ
Desktop) → Extract.

Mở PowerShell, `cd` vào đúng thư mục vừa giải nén. Cách dễ nhất: gõ `cd `
(có dấu cách), kéo thả thư mục từ File Explorer vào cửa sổ PowerShell,
Enter.

### Bước 4 — Chạy Postgres + Redis bằng Docker

```powershell
docker compose up -d postgres redis
```

Lệnh này tải và chạy sẵn Postgres + Redis, không cần tự cài đặt riêng.

### Bước 5 — Cài đặt project

```powershell
npm install
copy .env.example .env
notepad .env
```

Trong Notepad vừa mở, sửa dòng:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/robinhood_tracker
REDIS_URL=redis://localhost:6379
```
(2 dòng này khớp sẵn với cấu hình Docker ở Bước 4, thường không cần sửa
gì thêm). Lưu file (Ctrl+S), đóng Notepad.

### Bước 6 — Khởi tạo database và chạy bot

```powershell
npm run db:migrate
npm run dev
```

Mở trình duyệt vào **http://localhost:3000** — xong!

Dừng bot: quay lại cửa sổ PowerShell, nhấn `Ctrl + C`.

---

## Sau khi đã chạy được lần đầu

Những lần sau chỉ cần:

**macOS:**
```bash
cd đường-dẫn-tới-thư-mục-project
brew services start postgresql@16
brew services start redis
npm run dev
```

**Windows:**
```powershell
cd đường-dẫn-tới-thư-mục-project
docker compose up -d postgres redis
npm run dev
```

## Lỗi thường gặp

| Lỗi | Cách sửa |
|---|---|
| `npm: command not found` / không nhận lệnh `npm` | Chưa cài Node.js đúng cách — cài lại theo Bước 1, hoặc khởi động lại Terminal/PowerShell sau khi cài |
| Không kết nối được database | Postgres chưa chạy — Mac: `brew services start postgresql@16`; Windows: mở Docker Desktop lên, chạy `docker compose up -d postgres redis` |
| Dashboard mở trống, không có dữ liệu | Bình thường lúc mới chạy — chờ bot bắt được hoạt động thật trên chain |
| `Unknown field ... for select statement` | Database chưa cập nhật theo code mới — chạy `npm run db:migrate` rồi khởi động lại bot (`Ctrl+C` rồi `npm run dev`) |

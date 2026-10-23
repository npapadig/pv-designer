# Stream: kinito-api (ασφαλής πρόσβαση από το κινητό: backend)

**Στόχος (Νίκος, 2026-10-23):** εφαρμογή κινητού (PWA, βλ. `kinito-ui.md`) που συνδέεται στη δική μας εφαρμογή **μόνο για
ανάγνωση**: λίστα έργων, χάρτης, έγγραφα (PDF). Όχι σχεδίαση. Εδώ φτιάχνεις το backend και την ασφάλεια.

**Απόφαση του συντονιστή (τεχνική):** PWA (ιστοσελίδα που «εγκαθίσταται» στο κινητό, χωρίς store). Πρώτη έκδοση: ο
υπολογιστής του Νίκου και το κινητό στο ΙΔΙΟ Wi-Fi (τοπικό δίκτυο). Πρόσβαση από οπουδήποτε (internet, λογαριασμοί
χρηστών, hosting) = ΜΕΤΑ, με ξεχωριστή ερώτηση στον Νίκο (Roadmap 5). Η λειτουργία «Κινητό» είναι ΑΠΕΝΕΡΓΟΠΟΙΗΜΕΝΗ
από προεπιλογή.

**ΑΣΦΑΛΕΙΑ (το πιο σημαντικό):** σήμερα ο server ακούει μόνο στο `127.0.0.1`. Όταν ενεργοποιηθεί το «Κινητό» θα ακούει
και στο δίκτυο, άρα ΟΛΟ το API (σβήσιμο έργων, κλειδί Google κ.λπ.) θα ήταν ανοιχτό σε όποιον είναι στο Wi-Fi. Γι' αυτό:
1. Middleware: αιτήματα από μη-loopback διεύθυνση (δεν είναι 127.0.0.1/::1) επιτρέπονται ΜΟΝΟ σε `/m/*` (στατικά του
   κινητού), `/api/m/*` και `/api/version`· όλα τα άλλα → 403. Τεστ με ψεύτικο client host.
2. Κωδικός: ο Νίκος ορίζει κωδικό πρόσβασης κινητού (αποθήκευση ΜΟΝΟ hash, PBKDF2/scrypt από την standard library, στο
   `data/settings.json` μέσω `backend/settings.py`, ποτέ σε repo/log). `POST /api/m/login {password}` → token
   (τυχαίο, λήξη π.χ. 30 ημερών, αποθηκεύεται hash του token). Όριο προσπαθειών (π.χ. 5 λάθη → κλείδωμα 60 δευτ.).
3. Κάθε `/api/m/*` (εκτός login) απαιτεί `Authorization: Bearer <token>`. ΚΑΜΙΑ εγγραφή/διαγραφή έργων από το κινητό.
4. Το κλειδί Google ΔΕΝ δίνεται ποτέ στο κινητό (χάρτης κινητού: Esri/OSM). Καμία απάντηση δεν περιέχει κλειδιά.

**Συμβόλαιο API (το διαβάζει και η ροή kinito-ui — μην το αλλάξεις χωρίς να ενημερώσεις το `kinito-ui.md`):**
- `GET /api/m/status` → `{enabled, needs_password}` (χωρίς token· για την οθόνη σύνδεσης).
- `POST /api/m/login` `{password}` → `{token}` ή 401/429.
- `POST /api/m/logout` → ακυρώνει το token.
- `GET /api/m/projects` → `[{id, name, updated, kwp, panels, address, client}]`.
- `GET /api/m/projects/{id}` → `{id, name, areas, keepouts, layout: {panels, count, kwp, ...}, settings, report_info,
  energy (σύνοψη), electrical_ready: bool}` (όχι όλο το JSON αν είναι βαρύ).
- `GET /api/m/projects/{id}/documents` → λίστα `[{kind, title, available, reason}]` για: `report` (Αναφορά), `plan`
  (Κάτοψη), `single-line`, `tech`, `appendix-i`· `available:false` + λόγος (π.χ. «λείπει ο σχεδιασμός inverter»).
- `GET /api/m/projects/{id}/documents/{kind}?lang=el|en` → το PDF (ίδιες συναρτήσεις με τα υπάρχοντα endpoints:
  `report.build_pdf`, `plan_drawing`, `single_line`, `tech_description`, `appendix_i`).
- Τα ονόματα κωδικών σφαλμάτων/μηνύματα στα ελληνικά (και αγγλικά στο `frontend/lang/en.js` ΜΟΝΟ αν εμφανίζονται στο
  frontend της ροής ui· εσύ γράφεις μηνύματα server στα ελληνικά και τα προσθέτεις στο λεξικό `frontend/lang/en.js` ως
  «μηνύματα server»).

**Εκκίνηση/δίκτυο:** `backend/lifecycle.py`: η διεύθυνση ακρόασης γίνεται `0.0.0.0` ΜΟΝΟ αν το «Κινητό» είναι ενεργό
(ρύθμιση), αλλιώς `127.0.0.1` όπως τώρα. `GET /api/m/info` (μόνο από loopback, δηλαδή από τον υπολογιστή) → `{enabled,
urls: ["http://192.168.x.x:8000/m/"], password_set}` ώστε η εφαρμογή του υπολογιστή να δείχνει τη διεύθυνση / QR.
`POST /api/m/setup` (μόνο loopback) `{enabled, password?}` για ενεργοποίηση/απενεργοποίηση/αλλαγή κωδικού. Μετά από
αλλαγή του enabled ο server χρειάζεται επανεκκίνηση για να αλλάξει η διεύθυνση ακρόασης: το backend απαντά
`{restart_needed: true}` και το `lifecycle.py` ξαναξεκινά τον εαυτό του ή δείχνει σαφές μήνυμα (ό,τι είναι ασφαλέστερο στο
εύθραυστο launcher· ΜΗΝ σπάσεις το `start_windows.bat`/`update.ps1`, CRLF!). Windows firewall: το πρώτο άνοιγμα ρωτά
τον χρήστη· γράψε στο τέλος οδηγίες (greeklish στο console, ελληνικά στο README).

**Αρχεία (μόνο αυτά):** νέα `backend/mobile.py` (router + auth + middleware), `backend/settings.py` (πεδία mobile),
`backend/lifecycle.py` (ακρόαση), στο `backend/main.py` ΜΟΝΟ: `app.include_router(...)` και το middleware (λίγες
γραμμές), νέα τεστ `tests/test_mobile_api.py`, README (οδηγίες). Ο συντονιστής αλλάζει VERSION/CHANGELOG/HANDOFF.

**Βήματα (ένα commit το καθένα):**
1. Auth: κωδικός (hash), login/logout/status, όριο προσπαθειών, token, τεστ.
2. Middleware loopback-μόνο-εκτός-των-/m, τεστ ότι από ξένη διεύθυνση όλα εκτός `/m`, `/api/m`, `/api/version` δίνουν 403.
3. Endpoints projects + documents (τα 5 PDF), τεστ (με ψεύτικα δεδομένα· ΠΟΤΕ το πραγματικό `data/`).
4. setup/info (loopback) + ακρόαση 0.0.0.0 υπό συνθήκη + οδηγίες.

**Έλεγχοι:** `python -m pytest` όλα· baseline ίδιο· δοκιμή σε θύρα 8065 από το worktree με ΚΕΝΟ `data/`. Μην αλλάξεις
line endings ή άσχετα αρχεία. Ενημέρωνε τον πίνακα.

| Βήμα | Κατάσταση |
|---|---|
| 1 | ΕΤΟΙΜΟ (auth: κωδικός scrypt, token, lockout· 8 τεστ· σύνολο 335 OK) |
| 2 | ΕΤΟΙΜΟ (middleware loopback· 15 νέα τεστ στο test_mobile_api.py) |
| 3 | ΕΤΟΙΜΟ (projects + 5 PDF· 36 τεστ στο test_mobile_api.py) |
| 4 | ΕΤΟΙΜΟ (setup/info loopback, ακρόαση 0.0.0.0 υπό συνθήκη, README, μηνύματα en.js· δοκιμή live στη θύρα 8065 OK: από LAN IP 403 εκτός /m, /api/m, /api/version) |

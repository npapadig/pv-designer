# Όνομα και σήμα (συζήτηση με τον Νίκο, 2026-11-02) — ΧΩΡΙΣ αλλαγή κώδικα

Κατάσταση: όνομα αποφασισμένο (Solly)· μασκότ = πρόταση Τζιτζίκι, περιμένει επιβεβαίωση Νίκου. Δεν έχει αλλάξει τίποτα στην εφαρμογή ούτε στην έκδοση.

## Πού φαίνεται σήμερα το «PV Designer»
- Τίτλος σελίδας: `frontend/index.html` (`<title>`), `document.title` στο `frontend/app.js:1038`.
- Αρχική: `.home-head .logo` (εικονίδιο ήλιου `#i-sun`) και `<h1>PV Designer <small id="homeVersion">`.
- Ράγα βημάτων: κουμπί `#btnHome.logo` (ήλιος + σπίτι), κεφαλίδα `.brandname`.
- Κινητό: `frontend/m/index.html`, `m.js` (οθόνη κωδικού, `.logo` 72px), `m.css`.
- PDF/έγγραφα: συγγραφέας «PV Designer» σε `backend/report.py`, `appendix_i.py`, `single_line.py`, `tech_description.py`, `plan_drawing.py`· `backend/main.py` (τίτλος FastAPI), `backend/lifecycle.py` (παράθυρο μηνύματος).
- Πεδίο: σχεδιασμός φωτοβολταϊκών και μπαταριών, ταράτσες και πάρκα, Ελλάδα, ελληνικά + αγγλικά.

## Όνομα
- Ο Νίκος θέλει ΑΓΓΛΙΚΟ όνομα, «γλυκό, απλό, φιλικό» (όχι σοβαρό/τεχνικό). Απέρριψε τα ελληνικά (Ηλιοτρόπιο, Ηλιάτορας, Ηλιοσχέδιο) και τα σοβαρά αγγλικά (Heliotrope, Sunplot, Wattwise, Sunsketch).
- Του αρέσουν: **Solly** και **Sunny**, με σλόγκαν «Your bright friend» ή «… assistant».
- Έλεγχος (γρήγορο web search, ΟΧΙ μητρώα σημάτων ούτε domain): το «Sunny» συγκρούεται με το [Sunny Design της SMA](https://www.sma.de/en/products/apps-software/sunny-design) (ίδιο πεδίο) → αποφεύγουμε· το «Solly» μοιάζει με τη [Soly](https://siliconcanals.com/?p=144) (ολλανδική εταιρεία ηλιακών με εφαρμογή) → μικρός κίνδυνος μπέρδεματος.
- ΑΠΟΦΑΣΗ Νίκου: **Solly** + νέο σλόγκαν (προτεινόμενο: «Solly – your bright friend»).
- ΝΑ ΕΛΕΓΧΘΕΙ πριν από δημόσια χρήση: εμπορικά σήματα (EUIPO/ΟΒΙ), domain, ονόματα σε app stores.

## Σήμα / μασκότ
- Γύρος 1 (Sonnet): 3 απλά SVG (χαμογελαστός ήλιος, ήλιος πάνω από στέγη, φούσκα συνομιλίας). ΑΠΟΡΡΙΦΘΗΚΑΝ όλα («χάλια», θέλει πιο πρωτότυπη μασκότ).
- Γύρος 2 (Opus 5.5): 3 μασκότ που «κάνουν» αυτό που κάνει η εφαρμογή:
  1. **Τζιτζίκι** — ελληνικό καλοκαίρι, ζει στον ήλιο· τα φτερά του είναι φωτοβολταϊκά πάνελ (μπλε κελάκια).
  2. **Μέλισσα-μπαταρία** — σώμα μπαταρία, ρίγες = γραμμές φόρτισης, φτερά πάνελ· «μαζεύω ήλιο και τον κρατάω για το βράδυ».
  3. **Ηλιοτρόπιο-πάνελ** — λουλούδι που γυρίζει στον ήλιο, πρόσωπο = πάνελ.
- Ο Νίκος απάντησε «καμία προτίμηση» (2026-11-02). Πρόταση (ΟΧΙ τελική απόφαση): **Τζιτζίκι**, γιατί είναι το πιο πρωτότυπο, το πιο ελληνικό και διαβάζεται σε 28 px. Ο Νίκος μπορεί να το αλλάξει.
- Χρώματα: κίτρινο #F5B82E (σώμα), καφέ #5A3A00 (μάτια, ρίγες), μπλε πάνελ #2F6FD0 με γραμμές #A9CBF2 και περίγραμμα #1B3F75, ροζ μάγουλα #F29A7A. Φαίνεται σε λευκό και σε σκούρο #26231F.

Σκίτσο τζιτζικιού (πρώτο, όχι τελικό· κέντρο 0,0, περίπου 110×95):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -50 120 105">
<defs><pattern id="cells" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#2F6FD0"/><path d="M0 0H8M0 0V8" stroke="#A9CBF2" stroke-width="1"/></pattern></defs>
<path d="M-4 -12C-34 -20 -54 14 -44 44C-36 56 -16 34 -4 6Z" fill="url(#cells)" stroke="#1B3F75" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M4 -12C34 -20 54 14 44 44C36 56 16 34 4 6Z" fill="url(#cells)" stroke="#1B3F75" stroke-width="2.5" stroke-linejoin="round"/>
<ellipse cy="12" rx="13" ry="28" fill="#F5B82E"/>
<path d="M-11 14Q0 19 11 14M-10 24Q0 29 10 24M-7 33Q0 37 7 33" stroke="#5A3A00" stroke-width="2.5" fill="none" stroke-linecap="round"/>
<path d="M0 -36V-43M-11 -33L-15 -39M11 -33L15 -39" stroke="#F5B82E" stroke-width="3.5" fill="none" stroke-linecap="round"/>
<ellipse cy="-18" rx="24" ry="14" fill="#F5B82E"/>
<circle cx="-16" cy="-21" r="7.5" fill="#5A3A00"/><circle cx="-18" cy="-24" r="2.5" fill="#fff"/>
<circle cx="16" cy="-21" r="7.5" fill="#5A3A00"/><circle cx="14" cy="-24" r="2.5" fill="#fff"/>
<circle cx="-13" cy="-9" r="3" fill="#F29A7A"/><circle cx="13" cy="-9" r="3" fill="#F29A7A"/>
<path d="M-6 -11Q0 -6 6 -11" stroke="#5A3A00" stroke-width="2.5" fill="none" stroke-linecap="round"/>
</svg>
```

## Επόμενο βήμα για εφαρμογή (το κάνει ο συντονιστής, ΜΟΝΟ μετά από απόφαση σήματος)
1. Αντικατάσταση κειμένου «PV Designer» → «Solly» στα παραπάνω σημεία (+ `lang/en.js`, `tests/`, README, CHANGELOG, `docs/ARCHITECTURE.md`).
2. Νέο SVG σήματος στο `#i-sun`/`.logo`, στο κινητό και στα PDF (προαιρετικά).
3. Έκδοση minor + τεστ baseline αμετάβλητο.

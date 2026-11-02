# batteries-catalog — κατάλογος πραγματικών μπαταριών

Μέρος του σχεδίου `docs/streams/batteries.md` (κομμάτι v0.33). Ροή για μια συνεδρία Sonnet (effort medium), σε δικό της worktree.

## Στόχος
Ένα αρχείο `backend/catalog/batteries.json` με 15-25 πραγματικά μοντέλα μπαταριών οικιακής/μικρής εμπορικής χρήσης από δημόσια
φυλλάδια (datasheets) κατασκευαστών, ώστε ο χρήστης να τα διαλέγει στη λίστα «Μοντέλο» του βήματος «Μπαταρία». Η εφαρμογή
τα διαβάζει ΗΔΗ (`backend/battery.py`: `CatalogBattery`, `load_catalog`, `GET /api/battery/presets` → `catalog`, `frontend/battery.js`
τα βάζει στη λίστα και γεμίζει χωρητικότητα, ισχύ, χρήσιμο μέρος και απόδοση). Άρα εσύ γράφεις ΜΟΝΟ δεδομένα και τεστ.

## Αρχεία που ΑΝΗΚΟΥΝ σε αυτή τη ροή (μην αγγίξεις άλλα)
- `backend/catalog/batteries.json` (τώρα `[]`)
- `tests/test_battery_catalog.py` (νέο)
- `docs/streams/batteries-catalog-notes.md` (νέο: τι δεν επαληθεύτηκε / αποκλείστηκε, όπως το `equipment-catalog-notes.md`)
- αυτό το αρχείο (πίνακας κατάστασης)
ΜΗΝ αλλάξεις έκδοση (`VERSION`), `CHANGELOG.md`, `HANDOFF.md`, ούτε κώδικα εκτός από τα παραπάνω. Ο συντονιστής κάνει το merge και την έκδοση.

## Μορφή κάθε εγγραφής (πεδία του `CatalogBattery` στο `backend/battery.py`, διάβασε το)
`name` (π.χ. «Huawei LUNA2000-10-S0 (10 kWh)»), `brand`, `chemistry` (LFP / NMC / other), `capacity_kwh` (ό,τι το φυλλάδιο λέει ονομαστική/συνολική),
`usable_kwh` (χρήσιμη· αν δίνεται ένα μόνο νούμερο, βάλε το ίδιο και γράψε το στα `notes`), `power_kw` (συνεχής ισχύς εκφόρτισης ΑΥΤΗΣ της σύνθεσης),
`peak_power_kw` (ή null), `roundtrip_pct` (ή null αν το φυλλάδιο δεν δίνει), `coupling` («dc» αν θέλει το υβριδικό inverter του κατασκευαστή,
«ac» αν είναι ξεχωριστό AC-συζευγμένο σύστημα), `cycles`, `warranty_years`, `eol_capacity_pct` (ή null), `notes`, `source`
(ΠΛΗΡΗΣ διεύθυνση URL + όνομα εγγράφου + έκδοση/ημερομηνία, όπως στο `backend/catalog/inverters.json`).
Μία εγγραφή = ΜΙΑ σταθερή σύνθεση (π.χ. 10 kWh με 2 modules)· για άλλο μέγεθος του ίδιου προϊόντος ξεχωριστή εγγραφή.

## Κανόνες (όπως στον κατάλογο πάνελ/inverters)
- ΜΟΝΟ δημόσια φυλλάδια κατασκευαστών (ή επίσημες σελίδες προδιαγραφών). Καμία τιμή αγοράς. Κανένα νούμερο «από μνήμης»: αν δεν το βρίσκεις, null ή αποκλείεις την εγγραφή και το γράφεις στα notes.
- Προτίμηση σε μάρκες που βρίσκονται στην Ελλάδα/Ευρώπη: Huawei LUNA2000, BYD Battery-Box, Pylontech, SolaX, Sungrow, FoxESS, GoodWe, Tesla Powerwall, Fronius, SMA, Enphase, Dyness, Growatt, Victron, Solis, Deye κ.ά.
- Τα νούμερα όπως τα γράφει το φυλλάδιο (όχι δικοί σου υπολογισμοί). Αν χρειάζεται άθροισμα modules για τη σύνθεση, γράψε το στα `notes`.
- Όλα τα ονόματα μοναδικά. Το αρχείο JSON με UTF-8, ευανάγνωστο (indent 1 ή 2).
- ΧΡΗΣΗ web: WebSearch/WebFetch. Κάθε `source` να το έχεις πράγματι ανοίξει.

## Τεστ (νέο `tests/test_battery_catalog.py`)
Φόρτωση με `battery.load_catalog()` (το μοντέλο ελέγχει ήδη τα όρια)· επιπλέον: ≥ 10 εγγραφές, μοναδικά ονόματα, `source` ξεκινά με `http`,
`0.1 ≤ power_kw / capacity_kwh ≤ 2.5`, `usable_kwh ≥ 0.8 × capacity_kwh`, `roundtrip_pct` (όταν υπάρχει) 80-99, και ότι το API
`/api/battery/presets` επιστρέφει τις ίδιες εγγραφές. Τρέξε `python -m pytest` (ολόκληρο· πρέπει να περνά).
Αναφορά προς τον συντονιστή: πόσες εγγραφές μπήκαν, ποιες αποκλείστηκαν και γιατί, και commit του κλάδου σου (ένα commit, μήνυμα «batteries-catalog: …»).

## Κατάσταση
| Στοιχείο | Κατάσταση |
|---|---|
| Έρευνα φυλλαδίων | ✔ |
| `batteries.json` | ✔ (25) |
| `tests/test_battery_catalog.py` | ✔ |
| notes | ✔ |

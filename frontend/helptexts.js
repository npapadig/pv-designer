// Texts of the help bubbles (help.js), all in one place. One entry per element:
//   key: { sel, short, what, why, example }, optionally also name, place, text
//   sel      CSS selector of the element; without it, the element with data-help="<key>"
//   short    1-2 lines for the bubble
//   what / why / example   the three parts of the «Περισσότερα» box: «Τι κάνει», «Γιατί είναι
//            χρήσιμο», «Παράδειγμα»; "\n" starts a new paragraph
//   name     heading of the box, when the element's own text is not a good one
//   place    preferred side of the bubble: bottom (default), top, right, left
//   text     only the element whose text is exactly this (e.g. one option of the map menu)
// tests/test_help.py reads this file as JSON after small clean-ups, so keep to: double quotes,
// comments on their own lines, long texts split as "…" + on the next line "…".
window.HELP_TEXTS = {
  // ---------- Steps on the left ----------
  "rail-project": {
    sel: "#rail a[data-step=secProject]",
    name: "Βήμα 1: Έργο",
    place: "right",
    short: "Όνομα της μελέτης, στοιχεία για την αναφορά, αποθήκευση και άνοιγμα έργων.",
    what: "Εδώ δίνεις όνομα στη μελέτη, γράφεις αν θέλεις τα στοιχεία του πελάτη για την αναφορά PDF " +
      "και αποθηκεύεις, ανοίγεις ή διαγράφεις έργα.",
    why: "Η αποθήκευση κρατά όλη τη δουλειά (σχέδια στον χάρτη, πάνελ, ρυθμίσεις, αποτελέσματα), " +
      "ώστε να συνεχίσεις άλλη μέρα ή να φτιάξεις παραλλαγές για τον ίδιο πελάτη.",
    example: "π.χ. γράφεις «Σπίτι Παπαδόπουλου, Λάρισα», πατάς «Αποθήκευση» και την άλλη μέρα το ανοίγεις " +
      "από τη λίστα «Άνοιγμα έργου…».",
  },

  // ---------- Step 1: Έργο ----------
  projectName: {
    sel: "#projectName",
    short: "Το όνομα της μελέτης. Φαίνεται στη λίστα των έργων και στην αναφορά PDF.",
    what: "Ένα όνομα της επιλογής σου για αυτή τη μελέτη. Με αυτό το όνομα αποθηκεύεται το έργο " +
      "και γράφεται στην πρώτη σελίδα της αναφοράς PDF.",
    why: "Όταν έχεις πολλά έργα, ένα καθαρό όνομα σε βοηθά να βρεις γρήγορα το σωστό.",
    example: "π.χ. «Ταράτσα Κωνσταντίνου – 10 kWp» ή «Αποθήκη Βόλος, πρόταση 2».",
  },

  // ---------- Map menu (top right) ----------
  "map-esri": {
    sel: ".leaflet-control-layers-base label",
    text: "Δορυφόρος (Esri)",
    place: "left",
    short: "Δορυφορική φωτογραφία από την Esri. Η βασική επιλογή.",
    what: "Δείχνει τον χάρτη ως φωτογραφία από ψηλά (δορυφόρος ή αεροπλάνο), από την εταιρεία Esri. " +
      "Πάνω σε αυτή σχεδιάζεις τη στέγη και τα εμπόδια.",
    why: "Βλέπεις πραγματικά τη στέγη, τις καμινάδες και τα δέντρα, άρα σχεδιάζεις σωστά πού χωρούν πάνελ.",
    example: "π.χ. αν η εικόνα σε μια περιοχή είναι θολή, δοκίμασε «Esri Clarity» ή τις ορθοφωτογραφίες " +
      "του Κτηματολογίου από το ίδιο μενού.",
  },

  // ---------- Everywhere ----------
  theme: {
    sel: "#btnTheme, #homeTheme",
    name: "Σκούρο / φωτεινό θέμα",
    short: "Αλλάζει τα χρώματα της εφαρμογής: σκούρα ή φωτεινά.",
    what: "Εναλλάσσει την εμφάνιση ανάμεσα σε σκούρο φόντο και λευκό φόντο. " +
      "Η εφαρμογή θυμάται την επιλογή σου την επόμενη φορά.",
    why: "Το σκούρο κουράζει λιγότερο τα μάτια και ταιριάζει με τον δορυφορικό χάρτη. " +
      "Το φωτεινό διαβάζεται καλύτερα σε δυνατό φως.",
    example: "π.χ. δείχνεις τη μελέτη σε πελάτη σε οθόνη ή προβολέα, σε γραφείο με πολύ φως: διάλεξε το φωτεινό.",
  },
};

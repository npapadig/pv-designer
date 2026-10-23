"""English texts of the PDF report.

The report is written in Greek, and the Greek texts are the keys here. With lang="en", tr() looks a text
up in EN; if it is not there, the RULES (regular expressions, for texts with numbers that come from the
engine modules: shading, electrical design, finances) are applied one after the other. Finally, numbers in
Greek format (12.345,6) are turned into English format (12,345.6). A text that is not found stays Greek.
In Greek (the default) every text is returned exactly as it is.

Some short words need a different English word in a different place: those keys are "context|Greek text"
and the report asks for them with tr(text, context=...).
"""
from __future__ import annotations

import re

LANGS = ("el", "en")

EN: dict[str, str] = {
    # cover and page frame
    "ΜΕΛΕΤΗ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΥΣΤΗΜΑΤΟΣ": "PHOTOVOLTAIC SYSTEM STUDY",
    "Μελέτη φωτοβολταϊκού συστήματος": "Photovoltaic system study",
    "Μελέτη φωτοβολταϊκού – {name}": "Photovoltaic study – {name}",
    "Μελέτη ΦΒ - {name}.pdf": "PV study - {name}.pdf",
    "Σελίδα {page} από {total}": "Page {page} of {total}",
    "Έργο": "Project",
    "kWp ισχύς": "kWp power",
    "πάνελ": "panels",
    "kWh / έτος": "kWh / year",
    "Πελάτης": "Client",
    "Συντάκτης": "Prepared by",
    "Ημερομηνία": "Date",
    # summary
    "Σύνοψη έργου": "Project summary",
    "Προτείνεται φωτοβολταϊκό σύστημα ισχύος <b>{kwp} kWp</b> με <b>{count}</b> πάνελ, με κλίση {tilt}° και "
    "{compass} προσανατολισμό ({azimuth}°).":
        "The proposed photovoltaic system has a power of <b>{kwp} kWp</b>, with <b>{count}</b> panels at a tilt "
        "of {tilt}°, facing {compass} ({azimuth}°).",
    "Προτείνεται φωτοβολταϊκό σύστημα ισχύος <b>{kwp} kWp</b> με <b>{count}</b> πάνελ σε {faces} πλευρές "
    "στέγης, η καθεμία με τη δική της κλίση και προσανατολισμό.":
        "The proposed photovoltaic system has a power of <b>{kwp} kWp</b>, with <b>{count}</b> panels on {faces} "
        "roof faces, each with its own tilt and orientation.",
    "Η αναμενόμενη ετήσια παραγωγή είναι <b>{kwh} kWh</b>, δηλαδή {specific} kWh ανά εγκατεστημένο kWp.":
        "The expected annual production is <b>{kwh} kWh</b>, that is {specific} kWh per installed kWp.",
    "Στοιχεία έργου": "Project details",
    "Όνομα έργου": "Project name",
    "Διεύθυνση": "Address",
    "Συντεταγμένες": "Coordinates",
    "Ημερομηνία αναφοράς": "Report date",
    # floor-plan drawing (plan_drawing.py)
    "ΚΑΤΟΨΗ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΥΣΤΗΜΑΤΟΣ": "PHOTOVOLTAIC SYSTEM FLOOR PLAN",
    "Κάτοψη φωτοβολταϊκού συστήματος": "Photovoltaic system floor plan",
    "Διάταξη πάνελ": "Panel layout",
    "Κλίμακα": "Scale",
    "north|Β": "N",
    "Κάτοψη ΦΒ - {name}.pdf": "PV floor plan - {name}.pdf",
    "Συντεταγμένες κορυφών περιοχής εγκατάστασης": "Corner coordinates of the installation area",
    "ΕΓΣΑ87 (EPSG:2100) σε μέτρα· WGS84 σε μοίρες": "Greek grid EGSA87 (EPSG:2100) in metres; WGS84 in degrees",
    "Γεωγρ. πλάτος": "Latitude",
    "Γεωγρ. μήκος": "Longitude",
    "Οι συντεταγμένες προκύπτουν από το σχέδιο στο χάρτη (ενδεικτικές, ακρίβεια εικόνας χάρτη)· δεν αντικαθιστούν το σφραγισμένο τοπογραφικό διάγραμμα.": "The coordinates come from the drawing on the map (indicative, limited by the map image accuracy); they do not replace the sealed topographic diagram.",
    # compass
    "Βόρειος": "North", "Βορειοανατολικός": "Northeast", "Ανατολικός": "East", "Νοτιοανατολικός": "Southeast",
    "Νότιος": "South", "Νοτιοδυτικός": "Southwest", "Δυτικός": "West", "Βορειοδυτικός": "Northwest",
    # layout
    "Διάταξη και στοιχεία συστήματος": "Layout and system details",
    "Περιοχή εγκατάστασης": "Installation area",
    "Εμπόδια": "Obstacles",
    "Πάνελ": "Panels",
    "model|Πάνελ": "Panel",
    "(χωρίς δορυφορική εικόνα: δεν υπήρχε σύνδεση στο internet)":
        "(no satellite image: there was no internet connection)",
    "Στοιχεία συστήματος": "System details",
    "Εγκατεστημένη ισχύς (DC)": "Installed power (DC)",
    "Αριθμός πάνελ": "Number of panels",
    "Ισχύς πάνελ": "Panel power",
    "Διαστάσεις πάνελ": "Panel dimensions",
    "Τοποθέτηση": "Mounting",
    "Παράλληλα με κεκλιμένη στέγη": "Flush with a pitched roof",
    "Σε βάσεις (ταράτσα / έδαφος)": "On mounting frames (flat roof / ground)",
    "Προσανατολισμός πάνελ": "Panel orientation",
    "Κατακόρυφα": "Portrait",
    "Οριζόντια": "Landscape",
    "Κλίση": "Tilt",
    "Αζιμούθιο": "Azimuth",
    "Επιφάνεια περιοχής": "Size of the area",
    "Επιφάνεια πάνελ": "Total panel area",
    "Απόσταση από τα άκρα": "Distance from the edges",
    "Κενό μεταξύ σειρών": "Gap between rows",
    "Αριθμός εμποδίων": "Number of obstacles",
    "Πλευρές στέγης": "Roof faces",
    "{faces} (δες τον πίνακα)": "{faces} (see the table)",
    "Πλευρά": "Face",
    "Σκίαση": "Shading",
    "kWh/έτος": "kWh/year",
    "Σύνολο": "Total",
    "Κάθε πλευρά υπολογίζεται με τη δική της κλίση, προσανατολισμό και σκίαση. "
    "Αζιμούθιο: 0° Βορράς, 90° Ανατολή, 180° Νότος, 270° Δύση.":
        "Each face is calculated with its own tilt, orientation and shading. "
        "Azimuth: 0° North, 90° East, 180° South, 270° West.",
    # production
    "Παραγωγή ενέργειας": "Energy production",
    "kWh/m² ακτινοβολία στα πάνελ": "kWh/m² irradiation on the panels",
    "Μηνιαία παραγωγή": "Monthly production",
    "Μήνας": "Month",
    "Ακτινοβολία (kWh/m²)": "Irradiation (kWh/m²)",
    "Παραγωγή (kWh)": "Production (kWh)",
    "Ποσοστό έτους": "Share of the year",
    "Σύνολο έτους": "Year total",
    "Πηγή δεδομένων: {source}": "Data source: {source}",
    "PVGIS (Κοινό Κέντρο Ερευνών της Ευρωπαϊκής Επιτροπής), με δορυφορικά δεδομένα ακτινοβολίας "
    "για τη συγκεκριμένη τοποθεσία.":
        "PVGIS (Joint Research Centre of the European Commission), with satellite irradiation data "
        "for this location.",
    "Πρόχειρο μοντέλο καθαρού ουρανού (pvlib) χωρίς σύνδεση στο internet. Η εκτίμηση είναι λιγότερο ακριβής.":
        "Rough clear-sky model (pvlib) without an internet connection. The estimate is less accurate.",
    "Ιανουάριος": "January", "Φεβρουάριος": "February", "Μάρτιος": "March", "Απρίλιος": "April",
    "Μάιος": "May", "Ιούνιος": "June", "Ιούλιος": "July", "Αύγουστος": "August",
    "Σεπτέμβριος": "September", "Οκτώβριος": "October", "Νοέμβριος": "November", "Δεκέμβριος": "December",
    "Ιαν": "Jan", "Φεβ": "Feb", "Μαρ": "Mar", "Απρ": "Apr", "Μάι": "May", "Ιουν": "Jun",
    "Ιουλ": "Jul", "Αυγ": "Aug", "Σεπ": "Sep", "Οκτ": "Oct", "Νοε": "Nov", "Δεκ": "Dec",
    # losses
    "Απώλειες ενέργειας": "Energy losses",
    "Από την ηλιακή ενέργεια που φτάνει στα πάνελ μέχρι την ηλεκτρική ενέργεια που αποδίδει το σύστημα χάνεται "
    "ένα μέρος σε κάθε στάδιο. Το διάγραμμα δείχνει πόση ενέργεια χάνεται σε κάθε στάδιο μέσα στο έτος.":
        "From the solar energy that reaches the panels to the electricity that the system delivers, a part is "
        "lost at every stage. The chart shows how much energy is lost at each stage over the year.",
    "Ονομαστική ενέργεια (ακτινοβολία × kWp)": "Nominal energy (irradiation × kWp)",
    "Τελική παραγωγή (AC)": "Final production (AC)",
    "Σκιάσεις (εμπόδια και σειρές πάνελ)": "Shading (obstacles and panel rows)",
    "Γωνία πρόσπτωσης (ανακλάσεις στο γυαλί)": "Angle of incidence (reflections on the glass)",
    "Φασματικές επιδράσεις": "Spectral effects",
    "Θερμοκρασία και χαμηλή ακτινοβολία": "Temperature and low irradiance",
    "Απώλειες συστήματος (καλώδια, inverter κ.ά.)": "System losses (cables, inverter etc.)",
    "Συνολικές απώλειες (θερμοκρασία, inverter κ.ά.)": "Total losses (temperature, inverter etc.)",
    "Συνολικές απώλειες": "Total losses",
    "Performance ratio: ο λόγος της πραγματικής παραγωγής προς τη θεωρητική παραγωγή χωρίς καμία απώλεια. "
    "Τιμές 75–85% θεωρούνται καλές.":
        "Performance ratio: the actual production divided by the theoretical production without any loss. "
        "Values of 75–85% are considered good.",
    # detailed simulation (backend/simulation.py)
    "Σκιάσεις": "Shading",
    "Ανακλάσεις στο τζάμι (γωνία πρόσπτωσης)": "Reflections on the glass (angle of incidence)",
    "Σκόνη και ρύπανση": "Dust and soiling",
    "Θερμοκρασία πάνελ": "Panel temperature",
    "Ανομοιογένεια πάνελ (mismatch)": "Panel mismatch",
    "Ποιότητα πάνελ και αρχική υποβάθμιση": "Panel quality and initial degradation",
    "Καλώδια DC": "DC cables",
    "Απόδοση inverter": "Inverter efficiency",
    "Ψαλίδισμα inverter (clipping)": "Inverter clipping",
    "Καλώδια AC": "AC cables",
    "Διακοπές λειτουργίας": "Downtime",
    # optional sections
    "Ανάλυση σκιάσεων": "Shading analysis",
    "Ηλεκτρολογικός σχεδιασμός": "Electrical design",
    "Οικονομική ανάλυση": "Financial analysis",
    # notes
    "Παραδοχές και σημειώσεις": "Assumptions and notes",
    "Η παραγωγή είναι εκτίμηση με βάση ιστορικά μετεωρολογικά δεδομένα. Η πραγματική παραγωγή κάθε έτους μπορεί "
    "να διαφέρει, κυρίως λόγω καιρού.":
        "The production is an estimate based on historical weather data. The actual production of each year "
        "may differ, mainly because of the weather.",
    "Η διάταξη των πάνελ προκύπτει από σχεδίαση πάνω σε δορυφορική εικόνα και πρέπει να επιβεβαιωθεί με αυτοψία "
    "και μετρήσεις στο σημείο.":
        "The panel layout comes from a drawing on a satellite image and must be confirmed by a site visit "
        "and measurements on site.",
    "Δεν έχουν ληφθεί υπόψη σκιάσεις από γειτονικά κτίρια, δέντρα ή εμπόδια.":
        "Shading from neighbouring buildings, trees or obstacles has not been taken into account.",
    # shading section (backend/shading.py)
    "Ετήσια απώλεια από σκιάσεις": "Annual loss from shading",
    "από άμεσο ήλιο": "from direct sunlight",
    "από διάχυτο φως ουρανού": "from diffuse sky light",
    "Ηλιακή πρόσβαση (solar access)": "Solar access",
    "Πιο σκιασμένο πάνελ": "Most shaded panel",
    "Αιτίες": "Causes",
    "καμία": "none",
    "Απώλεια σκίασης ανά μήνα": "Shading loss per month",
    "Πάνελ ανά βαθμό σκίασης": "Panels by level of shading",
    "Ετήσια απώλεια": "Annual loss",
    "κάτω από 1%": "below 1%",
    "πάνω από 10%": "above 10%",
    "Οι σκιές υπολογίζονται από τη θέση του ήλιου σε κάθε μήνα και από τα ύψη των εμποδίων που σχεδιάστηκαν. "
    "Οι απώλειες έχουν αφαιρεθεί από την παραγωγή. Η μερική σκίαση ενός πάνελ μπορεί στην πράξη να κοστίζει "
    "λίγο περισσότερο, λόγω της ηλεκτρικής συνδεσμολογίας.":
        "Shadows are calculated from the position of the sun in every month and from the heights of the "
        "obstacles that were drawn. The losses have been subtracted from the production. In practice, partial "
        "shading of a panel may cost a little more, because of the electrical wiring.",
    # electrical section (backend/electrical.py)
    "Σύνδεση": "Grid connection",
    "Μονοφασική": "Single-phase",
    "Τριφασική": "Three-phase",
    "Πάνελ σε σειρά (string)": "Panels in series (string)",
    "Πλήθος strings": "Number of strings",
    "Συνδεδεμένα πάνελ": "Connected panels",
    "Ισχύς DC / AC": "DC / AC power",
    "Λόγος DC/AC": "DC/AC ratio",
    "Θερμοκρασίες κυττάρων σχεδιασμού": "Design cell temperatures",
    "Έλεγχος τάσεων και ρευμάτων": "Voltage and current check",
    "Μέγεθος": "Quantity",
    "Τιμή": "Value",
    "Όριο inverter": "Inverter limit",
    "Έλεγχος": "Check",
    "Μέγιστη τάση string (κρύο)": "Maximum string voltage (cold)",
    "Τάση λειτουργίας (ζέστη)": "Operating voltage (hot)",
    "Τάση λειτουργίας (κρύο)": "Operating voltage (cold)",
    "Ρεύμα ανά MPPT": "Current per MPPT",
    "Ρεύμα βραχυκύκλωσης ανά MPPT": "Short-circuit current per MPPT",
    "Συνδεσμολογία": "Wiring",
    "Strings ανά MPPT": "Strings per MPPT",
    "Strings ανά πλευρά στέγης": "Strings per roof face",
    "Πάνελ σε σειρά": "Panels in series",
    "Δικός μου inverter": "My own inverter",
    "Στην Ελλάδα η μονοφασική σύνδεση επιτρέπεται συνήθως έως 5 kVA. Προτίμησε τριφασικό inverter.":
        "In Greece a single-phase connection is usually allowed up to 5 kVA. Prefer a three-phase inverter.",
    "Επέλεξες ανάμειξη πλευρών: ένα string μπορεί να έχει πάνελ από πλευρές με διαφορετικό προσανατολισμό. "
    "Η πιο αδύναμη πλευρά «τραβά» προς τα κάτω όλο το string, οπότε χάνεται παραγωγή.":
        "You chose to mix roof faces: one string may have panels from faces with a different orientation. "
        "The weakest face “pulls down” the whole string, so production is lost.",
    # finance section (backend/finance.py)
    "Κόστος συστήματος": "System cost",
    "Επένδυση μετά την επιδότηση": "Investment after the subsidy",
    "Τρόπος σύνδεσης": "Connection scheme",
    "Μόνο ιδιοκατανάλωση": "Self-consumption only",
    "Net billing (πώληση περίσσειας)": "Net billing (surplus is sold)",
    "Net metering (ενεργειακός συμψηφισμός)": "Net metering (energy offsetting)",
    "Όφελος 1ου έτους": "First-year benefit",
    "Απόσβεση": "Payback",
    "Απόσβεση σε σημερινές τιμές": "Payback in today's money",
    "δεν αποσβένεται": "does not pay back",
    "Εσωτερικός βαθμός απόδοσης (IRR)": "Internal rate of return (IRR)",
    "Απόδοση επένδυσης (ROI)": "Return on investment (ROI)",
    "Κόστος ενέργειας (LCOE)": "Cost of energy (LCOE)",
    "Ταμειακές ροές ανά έτος": "Cash flows per year",
    "Έτος": "Year",
    "Όφελος": "Benefit",
    "Έξοδα": "Costs",
    "Καθαρό": "Net",
    "Σωρευτικό": "Cumulative",
    "Τα οικονομικά αποτελέσματα είναι εκτίμηση. Οι τιμές ρεύματος και οι όροι των προγραμμάτων αλλάζουν, "
    "και δεν αποτελούν δέσμευση.":
        "The financial results are an estimate. Electricity prices and the terms of the schemes change, "
        "and they are not a commitment.",
}

_N = r"(-?[\d.,]+)"  # a number in a rule
RULES: list[tuple[re.Pattern, str]] = [(re.compile(p), r) for p, r in [
    # whole texts
    (rf"^{_N} από {_N}$", r"\1 of \2"),
    (rf"^{_N} έως {_N} °C$", r"\1 to \2 °C"),
    (r"^έως (.+)$", r"up to \1"),
    (r"^από (.+)$", r"from \1"),
    (rf"^{_N} έτη$", r"\1 years"),
    (rf"^Καθαρή παρούσα αξία \(NPV, επιτόκιο {_N}%\)$", r"Net present value (NPV, discount rate \1%)"),
    (r"^Συνολικό καθαρό κέρδος (\d+) ετών$", r"Total net profit over \1 years"),
    # inverter names (backend/equipment.py)
    (r"Μονοφασικός", "Single-phase"),
    (r"Τριφασικός", "Three-phase"),
    # shading causes
    (r"(\d+) εμπόδιο\(α\) με ύψος", r"\1 obstacle(s) with a height"),
    (r"σκίαση μεταξύ σειρών πάνελ", "shading between panel rows"),
    # electrical checks
    (rf"^Η τάση του string στο κρύο \((.+?)\) φτάνει {_N} V και ξεπερνά το όριο του inverter \({_N} V\)\. "
     r"Μπορεί να καταστραφεί ο inverter\. Βάλε έως (\d+) πάνελ σε σειρά\.$",
     r"In the cold (\1) the string voltage reaches \2 V and goes over the inverter limit (\3 V). "
     r"The inverter may be damaged. Put at most \4 panels in series."),
    (rf"^Στη ζέστη \(κύτταρα (.+?)\) η τάση πέφτει στα {_N} V, κάτω από το κατώτατο όριο λειτουργίας του "
     rf"inverter \({_N} V\)\. Θα χάνεται παραγωγή\. Βάλε τουλάχιστον (\d+) πάνελ σε σειρά\.$",
     r"In the heat (cells at \1) the voltage drops to \2 V, below the lowest operating limit of the "
     r"inverter (\3 V). Production will be lost. Put at least \4 panels in series."),
    (rf"^Στο κρύο η τάση λειτουργίας \({_N} V\) ξεπερνά το πάνω όριο MPPT \({_N} V\)\. "
     r"Τις κρύες μέρες ο inverter δεν θα δουλεύει στο βέλτιστο σημείο\.$",
     r"In the cold the operating voltage (\1 V) goes over the upper MPPT limit (\2 V). "
     r"On cold days the inverter will not work at its best point."),
    (r"^Συνδέονται (\d+) strings σε ένα MPPT, ενώ ο inverter έχει (\d+) είσοδο\(ους\)\.$",
     r"\1 strings are connected to one MPPT, while the inverter has \2 input(s)."),
    (rf"^Το ρεύμα βραχυκύκλωσης ανά MPPT \({_N} A\) ξεπερνά το όριο του inverter \({_N} A\)\.$",
     r"The short-circuit current per MPPT (\1 A) goes over the inverter limit (\2 A)."),
    (rf"^Το ρεύμα ανά MPPT \({_N} A\) ξεπερνά το μέγιστο ρεύμα εισόδου \({_N} A\)\. "
     r"Ο inverter θα κόβει λίγη παραγωγή\.$",
     r"The current per MPPT (\1 A) goes over the maximum input current (\2 A). "
     r"The inverter will cut a little production."),
    (rf"^Λόγος DC/AC {_N}: αρκετά πάνελ για τον inverter, θα «ψαλιδίζεται» η παραγωγή τις πολύ ηλιόλουστες ώρες\.$",
     "DC/AC ratio \\1: many panels for the inverter, production will be “clipped” in very sunny hours."),
    (rf"^Λόγος DC/AC {_N}: ο inverter είναι μεγαλύτερος από όσο χρειάζεται\.$",
     r"DC/AC ratio \1: the inverter is bigger than needed."),
    (rf"^Η ισχύς πάνελ ανά inverter \({_N} kWp\) ξεπερνά τη μέγιστη επιτρεπόμενη \({_N} kWp\)\.$",
     r"The panel power per inverter (\1 kWp) goes over the maximum allowed (\2 kWp)."),
    (r"^Συνδέονται (\d+) από τα (\d+) πάνελ\. Τα (\d+) που περισσεύουν δεν χωρούν σε ολόκληρο string: "
     r"αφαίρεσέ τα ή άλλαξε τη διάταξη\.$",
     r"\1 of the \2 panels are connected. The \3 left over do not fit in a whole string: "
     r"remove them or change the layout."),
    (r"Οι πλευρές της στέγης \((\d+)\) χρειάζονται περισσότερα MPPT από όσα έχει ο inverter \((\d+)\): ",
     r"The roof faces (\1) need more MPPTs than the inverter has (\2): "),
    (r"(\d+) string\(s\) μοιράζονται MPPT με άλλη πλευρά και χάνεται λίγη παραγωγή",
     r"\1 string(s) share an MPPT with another face and a little production is lost"),
    (r"(\d+) string\(s\) δεν χωρούν σε κανένα MPPT και μένουν ασύνδετα",
     r"\1 string(s) do not fit on any MPPT and stay unconnected"),
    (r" και (?=\d+ string\(s\))", " and "),
    (r"\. Διάλεξε inverter με περισσότερα MPPT ή περισσότερους inverters\.$",
     ". Choose an inverter with more MPPTs, or more inverters."),
    (r"^Η πλευρά (\d+) έχει μόνο (\d+) πάνελ, λιγότερα από τα (\d+) που χρειάζεται ένα string για αυτόν τον "
     r"inverter\. Δεν συνδέονται\.$",
     r"Face \1 has only \2 panels, fewer than the \3 that a string needs for this inverter. "
     r"They are not connected."),
    # finance assumptions, one piece at a time
    (r"Παραδοχές: κόστος (\S+) €/kWp με ΦΠΑ", r"Assumptions: cost \1 €/kWp with VAT"),
    (r"τιμή ρεύματος (\S+) €/kWh", r"electricity price \1 €/kWh"),
    (r"πώληση περίσσειας (\S+) €/kWh", r"surplus sold at \1 €/kWh"),
    (r"αξία συμψηφισμού (\S+) €/kWh", r"offset value \1 €/kWh"),
    (r"ιδιοκατανάλωση (\S+)% της παραγωγής", r"self-consumption \1% of the production"),
    (r"αύξηση τιμών (\S+)% τον χρόνο", r"prices rise \1% a year"),
    (r"μείωση απόδοσης πάνελ (\S+)% τον χρόνο", r"panel output drops \1% a year"),
    (r"συντήρηση (\S+) €/kWp τον χρόνο", r"maintenance \1 €/kWp a year"),
    (r"αλλαγή inverter το (\d+)ο έτος \((\S+) €/kWp\)", r"new inverter in year \1 (\2 €/kWp)"),
]]

# A number in Greek format: 1.234 or 1.234,5 or 0,5 (Python's own 1.42 is left alone).
_GREEK_NUMBER = re.compile(r"(?<![\d.,])(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+)(?![\d])")


def english_numbers(text: str) -> str:
    """12.345,6 → 12,345.6 inside a text."""
    return _GREEK_NUMBER.sub(lambda m: m.group().translate(str.maketrans(".,", ",.")), text)


def tr(text, lang: str = "el", context: str = ""):
    """The text in the language of the report. Greek (or anything that is not text) comes back unchanged."""
    if lang != "en" or not isinstance(text, str) or not text.strip():
        return text
    core = text.strip()
    lead, trail = text[:len(text) - len(text.lstrip())], text[len(text.rstrip()):]
    en = EN.get(f"{context}|{core}") if context else None
    if en is None:
        en = EN.get(core)
    if en is None:
        en = core
        for pattern, repl in RULES:
            en = pattern.sub(repl, en)
    return lead + english_numbers(en) + trail

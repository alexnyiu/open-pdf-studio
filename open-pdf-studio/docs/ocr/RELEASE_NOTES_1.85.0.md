# Open PDF Studio 1.85.0 OCR release notes

## Nederlands

### Doorzoekbare OCR op macOS

- Herken machinaal gedrukte tekst met het gebundelde, offline meertalige
  PP-OCRv6-model. Het model kiest geen afzonderlijke taal; de ondersteunde talen
  worden automatisch samen verwerkt.
- Controleer en corrigeer herkende regels voordat ze als een onzichtbare
  Unicode-tekstlaag worden opgeslagen.
- Zoek en kopieer herkende tekst in Open PDF Studio en gangbare PDF-lezers.
- De veilige macOS-opslag controleert tekst, eigendom en pixels met PDF.js en
  PDFium voordat het originele bestand atomair wordt vervangen.

### Scantekst bewerken

- Bewerk één geïsoleerde horizontale OCR-regel.
- Bewerk 2 tot 32 samenhangende regels binnen één vaste oorspronkelijke regio.
- Laat één alinea veilig omlopen binnen een reeds goedgekeurde oorspronkelijke
  OCR-regio.
- Ongedaan maken, opnieuw uitvoeren, opnieuw openen en herhaald opslaan blijven
  gesynchroniseerd tussen de zichtbare en doorzoekbare tekstlagen.

Tekst blijft altijd binnen de oorspronkelijke bewerkingsregio. Open PDF Studio
verplaatst geen ongerelateerde pagina-inhoud en reconstrueert niet willekeurig
de volledige pagina-indeling of het exacte bronlettertype.

### Grenzen van deze release

- OCR-productieondersteuning geldt alleen voor macOS op Apple silicon. De
  arm64-app en universele OCR/PDFium-zijprocessen zijn gevalideerd. De
  distributieworkflow bouwt een universele app, maar de volledige Intel-GUI is
  niet op echte Intel-hardware gecertificeerd.
- Windows- en Linux-OCR worden niet ondersteund.
- Automatische paginarotatie en deskew zijn uitgeschakeld. Tabellen,
  handschrift, gebogen tekst, ernstige vervorming, complexe fotografische
  achtergronden en niet-ondersteunde scripts of tekstrichtingen vallen buiten
  de ondersteunde scope.
- Bewerkingen met ontbrekende tekens, niet-gecertificeerde vormgeving of te
  weinig ruimte worden expliciet geweigerd.
- Ondertekende PDF's vereisen Bewaar als en verliezen hun handtekeningvaliditeit
  bij wijziging. Versleutelde of met een wachtwoord beveiligde PDF's worden niet
  gewijzigd. PDF/A-uitvoer wordt alleen via Bewaar als naar gewone PDF omgezet.

OCR gebruikt lokale modellen; documentinhoud verlaat voor OCR deze Mac niet.
Zie de [volledige macOS-scope](MACOS_OCR_RELEASE_SCOPE.md) en de
[licentiemeldingen](THIRD_PARTY_NOTICES.md).

---

## English

### Searchable OCR on macOS

- Recognize machine-printed text with the bundled, offline, multilingual
  PP-OCRv6 model. There is no individual language selection; supported
  languages are considered together automatically.
- Review and correct recognized lines before saving an invisible Unicode text
  layer.
- Search and copy recognized text in Open PDF Studio and common PDF readers.
- Safe macOS save validates text, ownership, and pixels with PDF.js and PDFium
  before atomically replacing the original file.

### Scanned-text editing

- Edit one isolated horizontal OCR line.
- Edit 2 to 32 coherent lines inside one fixed original region.
- Safely reflow one paragraph inside an already-approved original OCR region.
- Undo, redo, reopen, and repeated save keep visible and searchable layers
  synchronized.

Text always remains inside its original edit region. Open PDF Studio does not
move unrelated page content or reconstruct arbitrary page layout or the exact
source font.

### Limits of this release

- OCR production support is macOS on Apple silicon only. The arm64 app
  packaging and universal OCR/PDFium sidecars are validated. The distribution
  workflow builds a universal app, but the full Intel GUI has not been
  certified on native Intel hardware.
- Windows and Linux OCR are not supported.
- Automatic page rotation and deskew are disabled. Tables, handwriting, curved
  text, severe distortion, complex photographic backgrounds, and unsupported
  scripts or directions are outside the supported scope.
- Edits with missing glyphs, uncertified shaping, or insufficient space are
  explicitly rejected.
- Signed PDFs require Save As and lose signature validity when modified.
  Encrypted or password-protected PDFs are not modified. PDF/A output is
  converted to standard PDF only through Save As.

OCR uses local models; document content does not leave this Mac for OCR. See
the [complete macOS scope](MACOS_OCR_RELEASE_SCOPE.md) and
[license notices](THIRD_PARTY_NOTICES.md).

# OCR-contractarchitectuur

Deze map bevat de bevroren productiecontracten voor de macOS-OCR-pijplijn. De bestanden `v1.js`, `engine.v1.schema.json` en `result.v1.schema.json` blijven ongewijzigd als Phase A-bewijs; nieuwe productiecode gebruikt de huidige exports uit `production.js`.

| Contract | Eigenaar | Mutabiliteit |
|---|---|---|
| `engine` en `result` v2 | OCR-engine | Onveranderlijk en reproduceerbaar; bevat alleen herkenningsdata, waarschuwingen, metrieken, unsupported-redenen en engine-identiteit. |
| `job` en `progress` v1 | Aanvrager en scheduler | Een job is een onveranderlijke opdracht voor precies één pagina; progress is een reeks engine-events. Applicatiestappen zoals toepassen en overslaan horen hier niet thuis. |
| `document-state` v1 | Documentlaag | Veranderlijk; bevat reviewstatus, correcties, acceptatie, geschatte baselines, zichtbare bewerkingsregio's en undo-metadata. |
| `page-geometry` v1 | PDF-/rastergrens | Onveranderlijk; bevat paginavakken, `UserUnit`, rotaties, werkelijke rasterafmetingen en de volledige inverteerbare transformatieketen. |
| `model-pack` v1 | Modelinstallatiegrens | Onveranderlijk; bevat exacte assets, checksums, platformcompatibiliteit, distributiebeleid, trust-root en toepassingsversies. |
| `worker-message` v1 | JavaScript Worker-grens | Strikt, afzonderlijk geversioneerd structured-clone-protocol voor opdrachten, resultaten, fouten en lifecycle-events. De rasterbuffer is het enige niet-JSON-veld en wordt overgedragen, niet gekopieerd. |

Page geometry is de enige autoriteit voor coördinaten. De keten gebruikt 3×3-homografiematrices met gecontroleerde inverses en provenance voor iedere bewerking. De vaste ruimtes zijn: `pdf-default-user-space` (PDF-usereenheden, PDF-nulpunt, y omhoog), `cropped-display-pdf-points` (CropBox na intrinsieke en applicatierotatie, linksboven, PDF-punten), `source-raster-pixels` (werkelijke PDFium-pixels), `orientation-adjusted-ocr-pixels`, `preprocessed-raster-pixels` en `ocr-engine-geometry` (alle linksboven, y omlaag). De extra orientatieruimte houdt oriëntatie en deskew als afzonderlijk inverteerbare bewerkingen. De matrixvorm kan later ook perspectiefcorrectie dragen; singuliere of numeriek instabiele matrices worden geweigerd.

Herkenningsgeometrie gebruikt `source-raster-pixels` of `preprocessed-raster-pixels`; de eerste naam is de bestaande productiealias voor rendered-raster pixels. Iedere polygoon en baseline noemt de ruimte. Een lijnpolygoon is verplicht; woordpolygonen zijn optioneel. Een ontbrekende engine-baseline wordt expliciet als `unavailable` vastgelegd. Een later berekende baseline hoort uitsluitend met provenance `estimated` in documentstate. Rechthoekige bounds zijn uitsluitend afgeleide hulpmiddelen en vervangen nooit polygonen of baselines. `pdf-default-user-space` en PDF-transformaties komen alleen voor in page geometry.

Job-, document-, pagina-, revisie-, generatie-, model-pack-, configuratie- en rasteridentiteiten vormen samen de stale-result-beveiliging. Een cache mag daarom alleen het gevalideerde, onveranderlijke engine-resultaat opslaan en nooit latere documentstate opnemen.

Alle inkomende waarden worden eerst op JSON-veiligheid, grootte, versie en exacte keys gecontroleerd. Migraties valideren zowel de bron als het nieuwe resultaat en maken geen woordgeometrie, alternatieven, taaldetectie, schrijfrichting of engine-baselines aan. `schema-validation.js` voert dezelfde fixturecorpora uit via de JSON Schema-route, inclusief de OCR-semantische keywords voor controles die standaard JSON Schema niet kan uitdrukken, zoals zelfsnijdende polygonen en rastergrenzen.

De Worker valideert een job vóór inferentie en valideert resultaatgrootte, aantallen en alle job-/document-/pagina-/revisie-/rasteridentiteiten vóór `postMessage`. `OcrEngine` herhaalt de bericht- en identiteitsvalidatie vóór het resultaat wordt vrijgegeven. Het Phase A v1-resultaat wordt alleen nog aan de bewaarde meetgrens gemaakt; de live adapter en Worker maken rechtstreeks het productie-resultaat.

De oude, ongepubliceerde gemengde v2-resultaatvorm is vervangen door deze scheiding en heeft geen tweede productiecontractfamilie. `migrateUnpublishedOcrResultV2ToCurrent` levert afzonderlijk een engine-resultaat, documentstate en optionele volledige page geometry. Een onvolledige oude paginatransformatie wordt niet stilzwijgend gepromoveerd.

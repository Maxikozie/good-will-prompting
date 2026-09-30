# CONTEXT — Hackathon SD Worx case: alles wat je moet weten

> Dit document bundelt de volledige context: de case, wat de jury wil (en niet wil), hoe ons
> idee geëvolueerd is, welke beslissingen vastliggen en hoe de bestanden samenhangen.
> Lees dit eerst als je instapt in het team (mens of Claude Code).
>
> **Repo-noot:** dit is het Brain-ontwerp (Casper). De MVP die nu in de repo draait heet **TrustLayer**
> (zie [solution.md](solution.md) en de root-README): dezelfde kerngedachte, maar deterministisch, zonder
> database en zonder LLM. `brain-spec.md` is de uitgebreide uitbreiding/roadmap daarop.
> Paden als `docs/brain/…` in de originele tekst staan hier als `brain/…`
> (`brain-spec.md` = SPEC.md, `brain-rules.md` = de Brain-CLAUDE.md).

---

## 1. De hackathon

- De grootste hackathon van België, georganiseerd door het team achter de Tectonic-conferentie.
  Het idee ontstond omdat een conferentie van twee dagen weinig echte innovatie opleverde.
- Er zijn meerdere partnercases. **Wij doen enkel de SD Worx-case (HR/payroll).** Andere
  cases (bv. finance) zijn niet relevant voor ons.
- Er is een hoofdprijs van € 10.000. De mindset die de organisatoren meegaven: ga ervoor, twijfel niet.
- Teams en zalen staan op de lijsten en grondplannen aan de deuren en zuilen.

### Aikido: 10% van de score gaat over security
- Aikido is een securityplatform (SAST, cloud/container-scanning, dev-machine protection en
  AI-pentesting / AI source code analysis).
- **10% van de eindscore = hoe veilig je project is.** Werkwijze:
  1. Registreren via hun QR-link en je krijgt 500 gratis credits.
  2. De GitHub-repo koppelen.
  3. Tegen het einde een **AI source code audit / AI SAST** draaien.
  4. Zoveel mogelijk gevonden kwetsbaarheden fixen. De score hangt af van het aantal fixes.
- Hun AI vindt ook **logic bugs en authenticatieproblemen**, niet enkel SQL-injectie.
  Voor ons zijn de relevante punten dus: auth, ACL's, tokens en prompt injection.
- Ons plan: security vanaf commit 1 meenemen, de scan halverwege een eerste keer draaien en vlak voor de deadline opnieuw.

---

## 2. De SD Worx-case

### Wie is SD Worx
- Gestart in Antwerpen. Nu actief in heel Europa met ±10.000 collega's en ±100.000 klanten.
  Ze maken **± 6 miljoen loonbrieven per maand**.
- Meer dan 100 payroll-services in meer dan 30 landen, veel payroll-engines, plus oplossingen voor workforce management, HCM, enzovoort.
- De presentator is Davies de Niels, product owner van **MySD Worx**: het portaal en de mobiele app waar
  klanten en hun werknemers terechtkomen. Het is de plek waar Pay, Time en HR samenkomen.

### MySD Worx-productlandschap (van de slide)
Zie [sd-worx.md](sd-worx.md) voor de volledige tabel (HR / Pay / Time). Achter elk product zit een team met eigen kennis. Die kennis staat overal verspreid.

### Het probleem
Kennis is versnipperd over:
- documenten, manuals en checklists
- SharePoint
- MS Teams-kanalen en chats
- oude e-mails
- **wat in de hoofden van mensen zit** (niet gedocumenteerd)

Combineer dat met de sterke groei van SD Worx, en je krijgt een structureel probleem.

### De twee voorbeelden van Davies (gebruik ze letterlijk in de pitch)
1. **Onboarding (Nike):** toen hij in 2010 begon, kreeg hij Nike als eerste klant. Dat was één
   Word-document en een gesprek van 30 minuten, en daarna wist hij alles. Vandaag zit Nike in meerdere
   Europese landen, gebruikt het veel tools van SD Worx en werkt het samen met veel teams. Nu zou
   hij niet weten wie hij moet bellen of welk document hij kan vertrouwen.
2. **Callcenter:** een klant belt met een dringende werknemersvraag. De collega vraagt het aan
   de bestaande agent, en die geeft **drie documenten** terug:
   - één zonder eigenaar (niemand weet wie het schreef)
   - één dat vorige week bewerkt is ("dat zal wel het recentste zijn…")
   - één met de juiste titel, maar van **een ander land**

   Daarbovenop pingt een collega: *"ik mail je de docs die je nodig hebt"*. Nu zit hij met
   **vier documenten** en weet hij niet welk juist is, terwijl de klant aan de lijn hangt.

### De challenge (slide)
> **How might we turn fragmented organisational knowledge into a trusted shared resource?**
> Build a focused proof of concept that makes knowledge easier to **FIND · TRUST · SHARE**.
> Choose a focused problem. You do not need to solve everything.

### Possible directions (slide: inspiratie, geen checklist)
| | |
|---|---|
| **Trust** | How can people know whether information is relevant and reliable? |
| **Capture** | How can valuable knowledge be made accessible beyond inboxes, documents or individual teams? |
| **Detect** | How can conflicting information or missing knowledge be identified? |
| **Connect** | How can people find the right expertise when documents are not enough? |

### Wat ze expliciet NIET willen
- **Geen SharePoint met een zoekfunctie.**
- **Geen extra AI-agent.** Die hebben ze al, en het probleem bestaat nog steeds.
- Niet alles willen oplossen. Kies één focusprobleem.

---

## 3. Ons kerninzicht

> **SD Worx heeft geen zoekprobleem, maar een vertrouwensprobleem.**
> Hun agent *vindt* al documenten. Wat ontbreekt, is een laag die zegt **welk stuk informatie juist is,
> waarom, waar het vandaan komt, wat ontbreekt en wie het moet bevestigen.**

Twee afgeleide principes:
- **De claim is de eenheid, niet het document.** Een document van 40 pagina's bevat 200
  uitspraken, waarvan er misschien 3 verouderd zijn. Scoren op documentniveau is dus te grof.
- **Nieuwste ≠ juist.** "Vorige week bewerkt" zegt niets als niemand het gecontroleerd heeft.
  Dat is exact de valkuil uit Davies' voorbeeld.

One-liners voor de pitch:
- *"Your agent finds documents. The Brain tells you which one to believe, why, and who to ask."*
- *"The newest document is not the right document."*
- *"Answer once, trusted forever."*

---

## 4. Evolutie van het idee (zodat je snapt waarom het is wat het is)

1. **Trust layer.** Een laag bovenop bestaande kennis met een Trust Card per resultaat, een
   conflictdetector en expert-routing. We scoren dus in plaats van te zoeken.
2. **MCP hub + regelset.** Een MCP hub die alle bronnen binnentrekt, met daarbovenop een gestructureerde
   regelset ("policy-as-code voor kennis"). De hub is loodgieterij; **de regels zijn het product.**
   De hub kan zelf een MCP server zijn die hun bestaande agent als tool aanroept. Dat is het schaalverhaal.
3. **De Brain-regels.** Een knowledge graph, verificatie-tiers met verval, authenticatie voor
   "Ask the owner", conflictflags plus een **oplossingsladder**, een **canonical index** en een
   scoresysteem waarin het verschil tussen oud en nieuw expliciet zit, plus een **health radar**.
4. **Finaal (het huidige plan).** De **MCP server wordt al gebouwd en de agent draait al.** Wij bouwen de laag
   erboven, **de Brain**:
   - De agent geeft voor een vraag documenten **A, B, C, D** terug.
   - De Brain kijkt op **claimniveau** wat overeenkomt, wat fout is, wat elkaar tegenspreekt en wat juist is.
   - Hij berekent **per bron hoeveel van het antwoord uit die bron komt** (bv. A 90%, B 3%, C 2%, wiki 5%).
   - Met die context zoekt hij **in de wikipagina's (overige bedrijfsinfo)** gericht naar wat ontbreekt
     of wat een zwak feit kan bevestigen.
   - **De documenten A–D en de wikipagina's blijven strikt gescheiden.**
   - Alles komt samen in de Brain: wat is juist, en wat moet nog geverifieerd worden door de eigenaar.

---

## 5. Hoe de Brain werkt (samenvatting; details in [brain-spec.md](brain-spec.md))

```
Vraag → 00 Intake → 10 Snapshot → 20 Extract → 30 Align → 40 Gaps
      → 50 Enrich (enkel wiki, gericht op gaps) → 60 Adjudicate (regels)
      → 70 Attribute (% per bron) → 80 Compose (antwoord met citaten)
      → 90 Ask the owner + canonical index + health radar
```

- **Twee corpora.** *Evidence* (de case-documenten A–D) en *reference* (de wiki). Ze hebben aparte DB-schema's,
  aparte vectorindexen, eigen ID-types en eigen codemappen, en mogen elkaar niet importeren. Ze worden enkel via
  edges verbonden.
- **Circulariteitscheck.** Een wikipagina die van doc A gekopieerd is, telt niet als extra bevestiging
  (`DERIVED_FROM`, dezelfde onafhankelijkheidsgroep).
- **Wiki alleen haalt nooit VERIFIED.** Het blijft maximaal PROVISIONAL.
- **Slots.** Per onderwerp ligt vast hoe een volledig antwoord eruitziet (bv. duur, voorwaarden,
  wanneer opnemen, doorbetaling, bewijs, wettelijke basis, ingangsdatum). Gaps worden daartegen gemeten.
- **Anti-hallucinatie.** Elke claim moet een letterlijke quote uit de bron hebben, anders wordt hij geschrapt.
- **De LLM extraheert en classificeert; regels beslissen.** Scores, statussen en winnaars zijn
  deterministisch en uitlegbaar via reason codes.
- **Scope is Belgisch-payroll-bewust.** Naast land ook paritair comité, bediende/arbeider, product en klant.

### Oplossingsladder bij conflicten
1. Scope-split: is het eigenlijk geen conflict, maar een ander land of PC?
2. Oudere duplicaatversie wordt afgewezen.
3. Autoriteit: een wettelijke bron of CAO wint.
4. Temporele opvolging: nieuwer én minstens even goed geverifieerd wint.
5. **Nieuwer maar niet geverifieerd:** het oude wint voorlopig, het conflict blijft open en er wordt geverifieerd.
6. Consensus van onafhankelijke bronnen.
7. Escalatie via Ask the owner.

### Oud-vs-nieuw-matrix
| | oud geverifieerd | oud niet geverifieerd |
|---|---|---|
| **nieuw geverifieerd** | nieuw wint | nieuw wint |
| **nieuw niet geverifieerd** | **oud wint voorlopig + conflict open** | beide zwak → consensus of escalatie |

### Scoring
```
ClaimScore = 100 × (0.30·Verificatie + 0.20·Autoriteit + 0.15·Ownership
                   + 0.15·Consensus + 0.10·Integriteit + 0.10·Usage) − ConflictPenalty
```
- Verificatie = tier (T0–T4) × verval (half-life per domein).
- Harde gates: vervallen, vervangen, geïnvalideerd door een wetswijziging, ander land.
- Banden: ≥ 80 trusted 🟢 · 60–79 use with care 🟠 · < 60 ask the owner 🔴.

### Attributie
Per antwoordfeit wordt het krediet verdeeld over de onafhankelijke bronnen die het ondersteunen, gewogen
op score, met een bonus voor de primaire bron. Het totaal telt op tot 100%. Afgewezen claims krijgen 0%.
Documenten en wiki worden apart gerapporteerd.

### Ask the owner
Routing loopt via de eigenaar, en anders via de beste expert voor dat domein en land. Authenticatie gebeurt
via (mock-)OIDC met eenmalige, ondertekende tokens die gebonden zijn aan feit en persoon. Er is een
vier-ogenprincipe voor feiten met hoge impact en een append-only audit log.

### Health radar
Acht assen per domein × land: freshness, ownership, consistency, verification depth,
coverage, bus factor, capture rate en resolution speed. Er zijn alerts voor vertrekkende owners,
wetswijzigingen/indexering (blast radius via de graph), terugkerende gaps en bus factor = 1.

---

## 6. Vaste technische keuzes

- Monorepo (pnpm), TypeScript, Node 20+. De nieuwe code komt in `packages/brain`.
- Postgres 16 + pgvector. De graph bestaat uit getypeerde tabellen plus één edge-tabel.
- Voorkeur voor self-hosted open-source: Ollama voor LLM en embeddings (`nomic-embed-text`), met een
  optionele Anthropic-provider en een **FakeProvider met opgenomen fixtures** voor een 100% deterministische demo.
- zod op elke grens, vitest, en `node --check` vóór elke commit.
- Er wordt gewerkt in **Claude Code-promptstappen met een git commit na elke stap**.
- De bestaande MCP server en agent worden **niet herschreven**, enkel uitgebreid. De Brain-tools worden als
  MCP-tools geregistreerd (`brain_analyze_case`, `brain_explain_fact`, `brain_submit_verification`,
  `brain_health`, …).

---

## 7. Demo-scenario (fictieve demodata)

Vraag (BE, PC 200, bediende): *"Hoeveel dagen klein verlet krijg ik voor mijn eigen huwelijk en
wanneer moet ik ze opnemen?"*

| Bron | Wat | Verwacht resultaat |
|---|---|---|
| A | HR-beleid BE, owner Sarah actief, geverifieerd: 2 dagen + alle voorwaarden | hoofdbron, grootste aandeel |
| B | Update, vorige week bewerkt, niet geverifieerd: 3 dagen | `NEWER_BUT_UNVERIFIED`, conflict open, Sarah + Tom gevraagd |
| C | Juiste titel, maar NL | `SCOPE_MISMATCH` |
| D | Doorgemailde bijlage, oudere versie van A | `DUPLICATE_OLDER_VERSION` |
| W1 | Wiki: verlofoverzicht België | onafhankelijke bevestiging |
| W2 | Wiki: kopie van A | `DERIVED_FROM`, geen extra krediet |
| W3 | Wiki: CAO/KB-referenties | vult wettelijke basis + ingangsdatum |
| W4 | Wiki uit 2019 zonder owner: 1 dag | afgewezen |

**Demoflow (3 min):**
1. De vraag komt binnen en de agent geeft A–D terug. Toon de chaos, precies zoals in Davies' verhaal.
2. De Brain geeft een verdict: "2 dagen", met citaten, per-bron-percentages en de afgewezen bronnen met reden.
3. Toon het conflict met B plus Ask the owner, en log live in als Sarah. Na bevestiging wordt het feit VERIFIED.
4. Trigger het event "indexering januari": de health radar zakt in en de verificatiewachtrij verschijnt.
5. Slotzin: *"Answer once, trusted forever."*

**Pitchstructuur:** hook (Davies' eigen verhaal) → inzicht (vertrouwen, niet zoeken) → live demo →
waarom het schaalt (plugt in de bestaande agent, 30 landen via scope, self-hostable, GDPR) → slotzin.

---

## 8. Security-checklist (voor die 10% van Aikido)
- Documenten zijn onbetrouwbare data. Er zit bewust een prompt-injectie in seed-doc B als test.
- ACL's worden meegedragen: niemand krijgt een verdict op content die hij niet mag lezen.
- Enkel parameterized SQL, zod op alle input, rate limiting op de MCP-tools.
- Tokens zijn eenmalig, kortlevend en worden bij submit opnieuw geautoriseerd.
- Geen secrets in de repo (`.env.example`). De audit log is append-only.

---

## 9. Bestanden en volgorde
| Bestand | Doel |
|---|---|
| `brain/brain-rules.md` | Invarianten en werkregels voor de Brain-laag (origineel: een aparte CLAUDE.md) |
| `brain/brain-context.md` | Dit document: waarom en wat |
| `brain/brain-spec.md` | Volledige technische spec: hoe precies |
| `PROMPTS.md` | 13 Claude Code-prompts (0–12), elk met een commit. **Nog niet in de repo.** |
| `INTEGRATION.md` | Wordt aangemaakt in Prompt 0: koppeling met de bestaande MCP en agent |
| `DECISIONS.md` | Wordt aangemaakt in Prompt 0: log van aannames en keuzes |

Volgorde: **Prompt 0 eerst** (recon van de bestaande MCP en agent). Stappen 0–9 vormen de minimale demo,
10–12 maken het finale-waardig. Draai de Aikido-scan na stap 9 en opnieuw na stap 12.

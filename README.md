# Mopedroute

Ein ausführbares, mobilfreundliches Webprojekt für Routen mit Mopedauto bzw. langsamem Leichtfahrzeug. Die Karte zeigt OpenStreetMap-Daten; Adressen werden über Nominatim gesucht, Routen berechnet Valhalla.

## Starten

Unter macOS genügt Ruby (ist auf den meisten Systemen bereits vorhanden). Es werden keine Pakete installiert.

```sh
ruby server.rb
```

Danach `http://localhost:4173` im Browser öffnen. Alternativ `start.command` doppelklicken, damit der Server startet und die Seite geöffnet wird. Wenn macOS den Start blockiert, im Terminal `ruby server.rb` im Projektordner ausführen.

Mit Node.js 18 oder neuer geht es ebenfalls:

```sh
npm start
```

Für den Zugriff von einem Smartphone im selben WLAN:

```sh
HOST=0.0.0.0 ruby server.rb
```

Dann im Smartphone-Browser `http://<IP-Adresse-des-Computers>:4173` aufrufen. Der Browser benötigt Internetzugriff für Karte, Adresssuche und Routing.

## Als Website auf GitLab Pages

Das öffentliche GitLab-Projekt enthält eine Pages-Konfiguration. Jeder Commit auf `main` veröffentlicht die statische Website automatisch unter [mopedauto-routeplaner-508e68.gitlab.io](https://mopedauto-routeplaner-508e68.gitlab.io/). GitLab vergibt für dieses Projekt eine eindeutige Pages-Adresse; sie steht auch im Projekt unter **Deploy > Pages**.

GitLab Pages führt keinen Ruby- oder Node-Server aus. Deshalb schaltet der Pages-Job `config.js` auf direkte Browser-Anfragen an Nominatim und Valhalla um. Für den lokalen Start bleibt die Server-Weiterleitung aktiv. Die Anbieter erhalten die Suchanfrage beziehungsweise Start/Ziel und Routeneinstellungen. Die Adresssuche wird nur nach Klick oder Enter ausgelöst, im Browser zwischengespeichert und auf höchstens eine Anfrage je 1,1 Sekunden pro Browser begrenzt. Die öffentlichen Dienste sind für geringe Nutzung gedacht; ihre Nutzungsregeln gelten weiterhin für die Website insgesamt. Für größere Nutzung bitte eigene Dienste oder einen eigenen zwischengespeicherten Proxy einsetzen.

## Bedienung

- Über die Navigation wechselst du zwischen Routenplaner, Tankbuch, Service, Parkplatz und Cockpit.
- Start und Ziel über die Suchsymbole oder durch Tippen auf die Karte setzen.
- Auf „Route berechnen“ tippen.
- Höchstgeschwindigkeit und Vermeidung von Autobahnen/Schnellstraßen anpassen.
- Der Standortknopf kann nach Zustimmung des Browsers den eigenen Standort als Start einsetzen.
- Nach der Routenberechnung kann ein Link für Google Maps oder Apple Karten geöffnet oder kopiert werden. Die Links enthalten Start, Ziel und bis zu drei Zwischenpunkte aus dem berechneten Verlauf; die Karten-App berechnet die Strecke anschließend selbst neu und übernimmt die 45-km/h-Fahrzeugregel nicht.
- Im Tankbuch werden Füllungen, Kilometerstand und Preis gespeichert. Aus zwei Volltank-Einträgen wird der Verbrauch in Litern je 100 km berechnet.
- Service-Erinnerungen können ein Fälligkeitsdatum, einen Kilometerstand oder beides haben. Der aktuelle Kilometerstand lässt sich manuell eintragen und wird während einer aktiven GPS-Aufzeichnung mit gefahrenen Kilometern ergänzt.
- Der Parkplatz lässt sich nach Standortfreigabe merken oder direkt auf der Karte auswählen. Die gespeicherte Position kann später auf der Karte angezeigt werden.
- Das Cockpit zeigt GPS-Geschwindigkeit, Genauigkeit und die Tageskilometer. Die Aufzeichnung läuft nur, solange die App geöffnet ist und eine Fahrt aktiv gestartet wurde; für verlässliche GPS-Werte das Gerät im Freien verwenden.

## Was das Routing abbildet

Die Anwendung sendet Valhalla eine Anfrage mit dem Kfz-Profil `auto`, der gewählten `top_speed` (30–80 km/h, standardmäßig 45 km/h) und `use_highways: 0`, wenn Autobahnen/Schnellstraßen möglichst gemieden werden sollen. Valhalla beschreibt `top_speed` als Höchstgeschwindigkeit, die auch zum Meiden schneller Straßen verwendet wird. `use_highways: 0` ist ausdrücklich eine Präferenz: Wenn keine passende Alternative existiert, kann Valhalla trotzdem eine Autobahn oder Schnellstraße in die Route aufnehmen. Die Geschwindigkeit ist keine rechtliche Freigabe; Fahrzeugpapiere, örtliche Regeln und Beschilderung haben Vorrang. Straßenklassifizierung und Zufahrtsbeschränkungen beruhen auf OpenStreetMap-Daten.

Das ist keine verbindliche Rechtsprüfung für ein bestimmtes Fahrzeug oder Land. Die App prüft nicht vollständig, ob jede Straße für die konkrete Fahrzeugklasse zugelassen ist, und kennt nicht zwingend aktuelle Baustellen oder Sperren. Beschilderung und Fahrzeugpapiere haben Vorrang.

## Dienste und Datenschutz

- **Karte:** OpenStreetMap-Kacheln über `tile.openstreetmap.org`, mit sichtbarer Namensnennung.
- **Adresssuche:** Öffentlicher Nominatim-Dienst. Gesucht wird nur nach ausdrücklichem Klick bzw. Enter; die Anwendung begrenzt Suchanfragen auf höchstens eine pro 1,1 Sekunden und hält Treffer im Arbeitsspeicher der lokalen Anwendung oder des Browser-Tabs zwischengespeichert.
- **Routen:** Öffentliche Valhalla-Demo von FOSSGIS. Die lokale Serverversion und die Pages-Website übermitteln Start, Ziel und Routeneinstellungen an `valhalla1.openstreetmap.de`.

Die öffentlichen Dienste sind für leichte Nutzung gedacht und können Limits oder Verfügbarkeit ändern. Für eine veröffentlichte oder stark genutzte App bitte eigene bzw. geeignete Dienste verwenden und deren Nutzungsregeln beachten. Die Basis-URLs lassen sich beim Start überschreiben:

```sh
NOMINATIM_URL=https://nominatim.openstreetmap.org VALHALLA_URL=https://valhalla1.openstreetmap.de/route npm start
```

Tankbuch, Wartungserinnerungen, Kilometerstand, Tageskilometer und gemerkter Parkplatz werden lokal im Browser des jeweiligen Geräts gespeichert. Es gibt keine Anmeldung oder Synchronisierung zwischen Geräten. Routen und Adresssuchen werden nicht dauerhaft in der App gespeichert; Suchtreffer und wiederholte Routenanfragen bleiben nur im Arbeitsspeicher des jeweiligen Tabs.

## Projektdateien

- `index.html` — App-Struktur und sichtbare Hinweise
- `config.js` — lokale/API-Einstellungen; Pages aktiviert die öffentlichen APIs beim Veröffentlichen
- `styles.css` — responsives Layout und Gestaltung
- `app.js` — Karte, Suche, Markierungen, Standort und Routenausgabe
- `server.rb` — lokaler Webserver und API-Weiterleitung für macOS
- `server.mjs` — alternative Node.js-Variante
- `start.command` — macOS-Doppelklickstarter
- `package.json` — Node.js-Startbefehle
- `.gitignore` — übliche lokale Dateien, die Git nicht übernehmen soll
- `.gitlab-ci.yml` — automatische Veröffentlichung mit GitLab Pages

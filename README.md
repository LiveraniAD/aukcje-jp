# Aukcje JP – opłacalność importu

Prywatna strona, która codziennie zbiera aukcje aut z Japonii, wycenia takie same auta na polskim rynku i liczy, do jakiej kwoty opłaca się licytować.

## Co robi

1. **Pobiera aukcje** z RajAuto i Fabryki Klasyków i scala te same aukcje w jedną (ten sam numer lotu, dzień licytacji i marka).
2. **Pokazuje tylko aukcje z ceną wywoławczą** większą od zera i z datą licytacji od dziś.
3. **Wycenia auto w Polsce**: mediana cen z Otomoto i Autoplacu dla tego samego modelu, rocznika ±1, podobnej pojemności silnika, w miarę możliwości tej samej wersji i podobnego przebiegu. Ogłoszenia z nietypową ceną są pomijane.
4. **Liczy koszty**: (cena + transport 12 000 zł) → cło 10% → akcyza 3,1% (do 2000 cm³) lub 18,6% → VAT 23%.
5. **Liczy opłacalność** względem mediany pomniejszonej o 15% oraz kwotę „Licytuj do”, przy której zostaje 15% zysku.
6. **Zapisuje historię** aukcji, żeby z czasem lepiej szacować cenę końcową licytacji.
7. **Pobiera kurs jena** z NBP.

## Pliki

| Ścieżka | Co to jest |
|---|---|
| `site/` | Strona (lista aukcji, karta auta, kalkulator). To ten folder jest publikowany. |
| `site/data/` | Dane generowane przez program – nie edytować ręcznie. |
| `scraper/run.ps1` | Program pobierający dane. |
| `config.json` | Ustawienia: koszty, tolerancje dopasowania, próg „perełek”, odstęp między zapytaniami. |
| `state/` | Pamięć programu: historia aukcji, zapamiętane wyceny, kurs. |
| `.github/workflows/odswiezanie.yml` | Codzienne automatyczne odświeżanie o 13:30 na GitHubie. |
| `serve.ps1` | Podgląd strony na własnym komputerze. |

## Uruchomienie na własnym komputerze (Windows)

Pełne odświeżenie danych (pierwsze trwa ok. 20–30 minut, kolejne krócej):

```
powershell -ExecutionPolicy Bypass -File scraper\run.ps1
```

Tylko kurs jena:

```
powershell -ExecutionPolicy Bypass -File scraper\run.ps1 -Mode rate
```

Podgląd strony pod adresem http://localhost:8377 :

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

## Darmowy hosting (GitHub Pages)

1. Załóż darmowe konto na github.com i utwórz repozytorium.
2. Wgraj do niego zawartość tego folderu.
3. W repozytorium: **Settings → Pages → Source: GitHub Actions**.
4. W zakładce **Actions** uruchom ręcznie „Odswiezanie aukcji” – po zakończeniu strona jest dostępna pod adresem podanym w Settings → Pages.
5. Od tej pory dane odświeżają się same codziennie o 13:30.

Uwaga: na darmowym koncie strona i repozytorium są publiczne (każdy, kto zna adres, może ją otworzyć). Strona prosi wyszukiwarki, żeby jej nie indeksowały.

## Powiadomienia o perełkach (opcjonalnie)

Perełka = auto bez uszkodzeń, z realną ceną wywoławczą, opłacalnością co najmniej 30% i wyceną z co najmniej 8 ogłoszeń. Progi zmienia się w `config.json` (`gems`).

- **ntfy** (najprościej, bez konta): zainstaluj aplikację ntfy na telefonie, zasubskrybuj własny, trudny do zgadnięcia temat i wpisz jego nazwę w repozytorium jako sekret `NTFY_TOPIC`.
- **Telegram**: sekrety `TELEGRAM_BOT_TOKEN` i `TELEGRAM_CHAT_ID`.

Sekrety dodaje się w **Settings → Secrets and variables → Actions**. Adres strony można podać jako zmienną `SITE_URL`, wtedy powiadomienie zawiera link do auta.

## Ograniczenia

- Regulaminy Otomoto i Autoplacu nie pozwalają na automatyczne pobieranie danych. Program pyta rzadko (jedno zapytanie na ok. sekundę, wyceny pamięta przez 40 godzin) i przedstawia się uczciwie, ale serwisy mogą takie zapytania zablokować.
- Serwisy aukcyjne nie publikują wyników licytacji, więc „szacowana cena licytacji” to na razie cena wywoławcza × 1,25 (mnożnik zmienisz w kalkulatorze).
- Notatki i ulubione zapisują się w przeglądarce, osobno na każdym urządzeniu.

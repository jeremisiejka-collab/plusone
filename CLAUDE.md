# +1 — zasady pracy

- **Wdrażaj zawsze automatycznie, bez pytania.** Po każdej skończonej i sprawdzonej zmianie: commit, scal do `main` i wypchnij `main`. Push na `main` uruchamia `.github/workflows/deploy.yml`, który publikuje stronę na plusoneapp.pl (Cloudflare Workers).
- Przed wdrożeniem uruchom stronę lokalnie i sprawdź ją w przeglądarce (telefon i komputer) — bez błędów JS.
- Komunikacja i teksty w aplikacji po polsku.

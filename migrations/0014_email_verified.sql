-- Potwierdzony adres e-mail: konto założone kodem z maila albo z linku zaproszenia. Zaproszenie z rolą dla istniejącego konta
-- wymaga potwierdzonego adresu (ktoś mógł wcześniej zarejestrować cudzy e-mail hasłem). Istniejące konta to administratorzy.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1;

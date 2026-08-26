"""Bootstrap a supervisor account so someone can log in via OTP.

The database starts EMPTY on first boot. At least one row in `supervisors`
is required for anyone to complete the /auth/request-otp -> /auth/verify-otp
flow.

Usage:
    cd /app/backend
    python scripts/create_supervisor.py --email you@company.com --name "Ravi Kumar"
    python scripts/create_supervisor.py --email you@company.com          # name defaults to email prefix
    python scripts/create_supervisor.py --email you@company.com --replace # overwrite an existing row

Options:
    --email    Login email (required). Must be the SAME address you'll type
               in the OTP screen — OTPs will be delivered to this inbox.
    --name     Human-readable name shown in the profile screen.
    --code     Optional supervisor code (e.g. SUP-0001). Auto-generated if omitted.
    --phone    Optional phone number.
    --replace  If a row for this email already exists, update it instead of
               erroring out.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# make `server` importable when script is run standalone
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from server import SessionLocal, Supervisor, Base, engine  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", default=None)
    parser.add_argument("--code", default=None)
    parser.add_argument("--phone", default=None)
    parser.add_argument("--designation", default="Supervisor")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    email = args.email.strip().lower()
    name = args.name or email.split("@")[0].replace(".", " ").title()
    code = args.code or f"SUP-{abs(hash(email)) % 10_000:04d}"

    # Ensure tables exist
    Base.metadata.create_all(bind=engine)

    with SessionLocal() as db:
        existing = db.query(Supervisor).filter(Supervisor.email == email).first()
        if existing and not args.replace:
            print(
                f"Supervisor with email {email!r} already exists "
                f"(name={existing.name!r}, code={existing.code!r}).\n"
                "Pass --replace to overwrite."
            )
            return 1

        if existing:
            existing.name = name
            existing.code = code
            if args.phone:
                existing.phone = args.phone
            existing.designation = args.designation
            action = "updated"
        else:
            db.add(
                Supervisor(
                    name=name,
                    code=code,
                    email=email,
                    phone=args.phone,
                    designation=args.designation,
                )
            )
            action = "created"
        db.commit()

    print(f"Supervisor {action}: {name} <{email}> (code={code}).")
    print("You can now request an OTP for this email from the login screen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

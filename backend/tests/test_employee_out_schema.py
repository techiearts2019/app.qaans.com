"""Verify that `EmployeeOut` exposes all 26 columns for
POST /api/employees, GET /api/employees, GET /api/employees/{id}, and
PATCH /api/employees/{id}. Fixes iter-6 bug where ~14 columns were dropped.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")
sys.path.insert(0, "/app/backend")

from server import (  # noqa: E402
    Allocation,
    AttendanceRecord,
    Employee,
    OtpCode,
    SalaryRecord,
    SessionLocal,
    Supervisor,
    password_hash,
)

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") + "/api"

EXPECTED_KEYS = {
    "id", "name", "name_hi", "code", "designation", "skill",
    "gender", "marital_status", "dob", "father_name", "nominee",
    "primary_mobile", "alt_mobile", "email",
    "date_of_joining", "date_of_exit",
    "current_address", "permanent_address",
    "aadhaar", "pan", "uan", "esi",
    "status", "photo",
    "project_id", "project_name",
}


# --- module-level fixtures --------------------------------------------------
@pytest.fixture(scope="module")
def token() -> str:
    with SessionLocal() as db:
        sup = db.query(Supervisor).first()
        assert sup, "no supervisor row seeded"
        email = sup.email
        db.query(OtpCode).filter(OtpCode.email == email.lower()).delete()
        db.add(
            OtpCode(
                email=email.lower(),
                code_hash=password_hash.hash("123456"),
                expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
                + timedelta(minutes=5),
                attempts=0,
            )
        )
        db.commit()
    r = requests.post(
        f"{BASE_URL}/auth/verify-otp",
        json={"email": email, "otp": "123456"},
        timeout=60,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def headers(token) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# Extended-fields payload — every optional column populated so we can round-trip.
EXTENDED_PAYLOAD = {
    "name": "Schema Round Trip",
    "name_hi": "स्कीमा",
    "code": None,  # filled per-test with unique code
    "designation": "Senior Fitter",
    "skill": "Welding",
    "gender": "Male",
    "marital_status": "Married",
    "dob": "01 Jan 1990",
    "father_name": "Test Father",
    "nominee": "Test Nominee",
    "primary_mobile": "9999999901",
    "alt_mobile": "8888888802",
    "email": "schema.round@test.local",
    "date_of_joining": "01 Feb 2020",
    "date_of_exit": "31 Dec 2030",
    "current_address": "12 Test Lane, Ward 4, Delhi",
    "permanent_address": "Village Kheri, Distt X",
    "aadhaar": "111122223333",
    "pan": "ABCDE1234F",
    "uan": "100200300400",
    "esi": "5001234567",
    "status": "No Allocation",
}


def _make_payload(code: str) -> dict:
    p = dict(EXTENDED_PAYLOAD)
    p["code"] = code
    return p


def _cleanup(code: str):
    with SessionLocal() as db:
        emp = db.query(Employee).filter(Employee.code == code).first()
        if not emp:
            return
        db.query(Allocation).filter(Allocation.employee_id == emp.id).delete()
        db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == emp.id
        ).delete()
        db.query(SalaryRecord).filter(
            SalaryRecord.employee_id == emp.id
        ).delete()
        db.delete(emp)
        db.commit()


# --- 1. POST /employees returns full EmployeeOut ---------------------------
class TestPostEmployeeOutSchema:
    def test_post_response_has_all_26_keys_and_values(self, headers):
        code = f"TEST-SCHEMA-POST-{datetime.now().strftime('%H%M%S%f')}"
        payload = _make_payload(code)
        try:
            r = requests.post(
                f"{BASE_URL}/employees",
                headers=headers, json=payload, timeout=30,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            missing = EXPECTED_KEYS - set(body.keys())
            assert not missing, f"POST response missing keys: {missing}"
            # Values round-trip for every writable column
            for k, v in payload.items():
                assert body[k] == v, f"POST body[{k}]={body[k]!r} != payload {v!r}"
            # Read-only fields are populated correctly
            assert isinstance(body["id"], str) and body["id"]
            assert body["project_id"] is None
            assert body["project_name"] is None
            assert body["photo"] is None
        finally:
            _cleanup(code)


# --- 2. GET /employees/{id} returns full EmployeeOut -----------------------
class TestGetEmployeeByIdOutSchema:
    def test_get_by_id_response_has_all_26_keys_and_values(self, headers):
        code = f"TEST-SCHEMA-GET1-{datetime.now().strftime('%H%M%S%f')}"
        payload = _make_payload(code)
        try:
            r = requests.post(
                f"{BASE_URL}/employees",
                headers=headers, json=payload, timeout=30,
            )
            assert r.status_code == 200, r.text
            emp_id = r.json()["id"]

            g = requests.get(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers, timeout=15,
            )
            assert g.status_code == 200, g.text
            body = g.json()
            missing = EXPECTED_KEYS - set(body.keys())
            assert not missing, f"GET by id missing keys: {missing}"
            for k, v in payload.items():
                assert body[k] == v, (
                    f"GET/{{id}} body[{k}]={body[k]!r} != payload {v!r}"
                )
            assert body["id"] == emp_id
        finally:
            _cleanup(code)


# --- 3. GET /employees list uses same EmployeeOut --------------------------
class TestGetEmployeesListOutSchema:
    def test_list_row_has_all_26_keys_and_values(self, headers):
        code = f"TEST-SCHEMA-LIST-{datetime.now().strftime('%H%M%S%f')}"
        payload = _make_payload(code)
        try:
            r = requests.post(
                f"{BASE_URL}/employees",
                headers=headers, json=payload, timeout=30,
            )
            assert r.status_code == 200, r.text
            emp_id = r.json()["id"]

            g = requests.get(
                f"{BASE_URL}/employees", headers=headers, timeout=30,
            )
            assert g.status_code == 200, g.text
            rows = g.json()
            assert isinstance(rows, list)
            row = next((x for x in rows if x.get("id") == emp_id), None)
            assert row is not None, "newly created employee not returned by list"
            missing = EXPECTED_KEYS - set(row.keys())
            assert not missing, f"GET /employees row missing keys: {missing}"
            for k, v in payload.items():
                assert row[k] == v, (
                    f"list row[{k}]={row[k]!r} != payload {v!r}"
                )
        finally:
            _cleanup(code)


# --- 4. PATCH /employees/{id} returns full EmployeeOut with updated values -
class TestPatchEmployeeOutSchema:
    def test_patch_response_has_all_26_keys_and_reflects_update(self, headers):
        code = f"TEST-SCHEMA-PATCH-{datetime.now().strftime('%H%M%S%f')}"
        payload = _make_payload(code)
        try:
            r = requests.post(
                f"{BASE_URL}/employees",
                headers=headers, json=payload, timeout=30,
            )
            assert r.status_code == 200, r.text
            emp_id = r.json()["id"]

            update = {
                "designation": "Updated Foreman",
                "current_address": "Updated Address 42",
                "aadhaar": "444455556666",
                "gender": "Female",
                "marital_status": "Single",
                "alt_mobile": "7777777703",
            }
            p = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers, json=update, timeout=30,
            )
            assert p.status_code == 200, p.text
            body = p.json()
            missing = EXPECTED_KEYS - set(body.keys())
            assert not missing, f"PATCH response missing keys: {missing}"
            # Updated fields reflect new values
            for k, v in update.items():
                assert body[k] == v, (
                    f"PATCH body[{k}]={body[k]!r} != update {v!r}"
                )
            # Non-updated fields remain original
            untouched = {
                "name": payload["name"],
                "code": payload["code"],
                "skill": payload["skill"],
                "dob": payload["dob"],
                "father_name": payload["father_name"],
                "nominee": payload["nominee"],
                "primary_mobile": payload["primary_mobile"],
                "email": payload["email"],
                "date_of_joining": payload["date_of_joining"],
                "date_of_exit": payload["date_of_exit"],
                "permanent_address": payload["permanent_address"],
                "pan": payload["pan"],
                "uan": payload["uan"],
                "esi": payload["esi"],
            }
            for k, v in untouched.items():
                assert body[k] == v, (
                    f"PATCH body[{k}]={body[k]!r} should still equal {v!r}"
                )
        finally:
            _cleanup(code)

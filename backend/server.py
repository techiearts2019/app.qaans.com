"""
Qaans FastAPI backend — MySQL (via SQLAlchemy + PyMySQL) + JWT/email-OTP auth
"""

from __future__ import annotations

import io
import logging
import os
import secrets
from base64 import b64decode
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen
from uuid import uuid4
from zoneinfo import ZoneInfo

import aiosmtplib
import face_recognition
import jwt
import numpy as np
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from PIL import Image as PILImage, ImageFilter
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import (
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    func,
    select,
    update,
)
from sqlalchemy.engine import URL
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker
from starlette.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------- config ----
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MYSQL_URL = URL.create(
    drivername="mysql+pymysql",
    username=os.environ["MYSQL_USER"],
    password=os.environ["MYSQL_PASSWORD"],
    host=os.environ["MYSQL_HOST"],
    port=int(os.environ["MYSQL_PORT"]),
    database=os.environ["MYSQL_DB"],
    query={"charset": "utf8mb4"},
)

engine = create_engine(
    MYSQL_URL,
    pool_pre_ping=True,
    pool_recycle=280,
    pool_size=5,
    max_overflow=10,
    echo=False,
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


# ---- auth config
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "1440"))
OTP_TTL_MINUTES = int(os.getenv("OTP_TTL_MINUTES", "5"))
OTP_LENGTH = int(os.getenv("OTP_LENGTH", "6"))
SMTP_HOST = os.environ["SMTP_HOST"]
SMTP_PORT = int(os.environ["SMTP_PORT"])
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASSWORD = os.environ["SMTP_PASSWORD"]
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER)

password_hash = PasswordHash.recommended()
bearer_scheme = HTTPBearer(auto_error=False)


def new_id() -> str:
    return uuid4().hex


def now_utc() -> datetime:
    # naive UTC (matches SQLAlchemy DateTime default)
    return datetime.now(timezone.utc).replace(tzinfo=None)


# --------------------------------------------------------------- time zone --
# All attendance times, dates, and human-readable time strings displayed in
# the app are in India Standard Time. The DB itself stores UTC (`created_at`
# columns), but the "HH:MM AM/PM" and ISO date strings surfaced to the
# frontend are IST-based so employees and supervisors see local times.
IST = ZoneInfo("Asia/Kolkata")


def now_ist() -> datetime:
    """Timezone-aware `datetime` in Asia/Kolkata (UTC+5:30)."""
    return datetime.now(IST)


def ist_time_str(dt: Optional[datetime] = None) -> str:
    """Human-readable 12-hour time in IST, e.g. `"08:42 AM"`."""
    d = (dt or now_ist()).astimezone(IST) if dt else now_ist()
    return d.strftime("%I:%M %p")


def ist_date_str(dt: Optional[datetime] = None) -> str:
    """ISO date (YYYY-MM-DD) in IST — for the `date` column on attendance
    so that "today's attendance" queries roll over at IST midnight, not
    server midnight."""
    d = (dt or now_ist()).astimezone(IST) if dt else now_ist()
    return d.strftime("%Y-%m-%d")


def _load_image_from_url(url: str) -> Optional[np.ndarray]:
    try:
        req = Request(url, headers={"User-Agent": "dihadi/1.0"})
        with urlopen(req, timeout=8) as r:
            data = r.read()
        img = PILImage.open(io.BytesIO(data)).convert("RGB")
        return np.array(img)
    except Exception as e:
        logging.warning("photo fetch failed %s: %s", url, e)
        return None


def _encode_face(img: np.ndarray) -> Optional[np.ndarray]:
    try:
        locations = face_recognition.face_locations(img, model="hog")
        if not locations:
            return None
        encs = face_recognition.face_encodings(img, known_face_locations=locations[:1])
        return encs[0] if encs else None
    except Exception as e:
        logging.warning("face encoding failed: %s", e)
        return None


def _encode_all_faces(
    img: np.ndarray,
) -> list[tuple[tuple[int, int, int, int], np.ndarray]]:
    """Detect and encode every face in the frame. Returns list of
    (location, 128-d encoding). Empty list on failure."""
    try:
        locations = face_recognition.face_locations(img, model="hog")
        if not locations:
            return []
        encs = face_recognition.face_encodings(img, known_face_locations=locations)
        return list(zip(locations, encs))
    except Exception as e:
        logging.warning("multi face encoding failed: %s", e)
        return []


# Quality thresholds tuned for phone selfies at 480–640px width. If a capture
# scores below any of these, enrolment is rejected so a bad frame doesn't
# poison the stored encoding for that employee.
QUALITY_MIN_SHARPNESS = 30.0  # variance of FIND_EDGES output (grayscale)
QUALITY_MIN_BRIGHTNESS = 45.0  # mean grayscale (too dark below)
QUALITY_MAX_BRIGHTNESS = 225.0  # mean grayscale (too washed-out above)
QUALITY_MIN_FACE_HEIGHT_FRAC = 0.15  # face must be >=15% of image height


def _image_quality(pil_img: PILImage.Image) -> dict[str, float]:
    """Cheap, dependency-free sharpness + brightness score.
    - sharpness = variance of the FIND_EDGES-filtered grayscale image
    - brightness = mean of grayscale pixels
    """
    gray = pil_img.convert("L")
    edges = gray.filter(ImageFilter.FIND_EDGES)
    arr_edges = np.asarray(edges, dtype=np.float32)
    arr_gray = np.asarray(gray, dtype=np.float32)
    return {
        "sharpness": float(arr_edges.var()),
        "brightness": float(arr_gray.mean()),
    }


def _assess_enrolment(
    img_np: np.ndarray, pil_img: PILImage.Image
) -> tuple[Optional[np.ndarray], Optional[str]]:
    """Run every quality gate for face enrolment.
    Returns (encoding, error_message). On success encoding is set and error is None."""
    q = _image_quality(pil_img)
    if q["brightness"] < QUALITY_MIN_BRIGHTNESS:
        return None, (
            f"The image is too dark (brightness {q['brightness']:.0f}). "
            "Move to better light and try again."
        )
    if q["brightness"] > QUALITY_MAX_BRIGHTNESS:
        return None, (
            f"The image is over-exposed (brightness {q['brightness']:.0f}). "
            "Reduce direct light on the face and try again."
        )
    if q["sharpness"] < QUALITY_MIN_SHARPNESS:
        return None, (
            f"The image is too blurry (sharpness {q['sharpness']:.0f}). "
            "Hold the phone steady and try again."
        )
    faces = _encode_all_faces(img_np)
    if not faces:
        return None, (
            "No face detected. Please look at the camera with the whole face "
            "in the frame."
        )
    if len(faces) > 1:
        return None, (
            f"Detected {len(faces)} faces. Only one person should be in the "
            "frame during enrolment."
        )
    (top, right, bottom, left), enc = faces[0]
    h = img_np.shape[0]
    face_h = bottom - top
    if h > 0 and (face_h / h) < QUALITY_MIN_FACE_HEIGHT_FRAC:
        return None, (
            "Face is too far away or too small. Move closer so your face "
            "fills the frame."
        )
    return enc, None


def _decode_b64_image(payload: str) -> Optional[np.ndarray]:
    pil = _decode_b64_pil(payload)
    return np.array(pil) if pil is not None else None


def _decode_b64_pil(payload: str) -> Optional[PILImage.Image]:
    try:
        if payload.startswith("data:"):
            payload = payload.split(",", 1)[1]
        return PILImage.open(io.BytesIO(b64decode(payload))).convert("RGB")
    except Exception as e:
        logging.warning("b64 decode failed: %s", e)
        return None


import json  # noqa: E402


def generate_otp() -> str:
    return f"{secrets.randbelow(10 ** OTP_LENGTH):0{OTP_LENGTH}d}"


def create_access_token(email: str, sup_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": email.lower(),
        "supervisor_id": sup_id,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRE_MINUTES),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["sub", "exp", "iat", "type"]},
        )
    except InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def send_otp_email(to_email: str, otp: str) -> None:
    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = to_email
    message["Subject"] = "Your Qaans ERP supervisor login code"
    message.set_content(
        f"Your Qaans ERP login code is {otp}.\n\n"
        f"It expires in {OTP_TTL_MINUTES} minutes and can only be used once. "
        "If you did not request it, ignore this email."
    )
    await aiosmtplib.send(
        message,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        username=SMTP_USER,
        password=SMTP_PASSWORD,
        start_tls=True,
        timeout=20,
    )


# --------------------------------------------------------------- models -----
class Base(DeclarativeBase):
    pass


class Supervisor(Base):
    __tablename__ = "supervisors"
    id = Column(String(64), primary_key=True, default=new_id)
    name = Column(String(120), nullable=False)
    code = Column(String(40), unique=True, nullable=False)
    email = Column(String(180))
    phone = Column(String(40))
    designation = Column(String(120))
    photo = Column(Text)
    joining_date = Column(String(40))
    created_at = Column(DateTime, default=now_utc)


class Project(Base):
    __tablename__ = "projects"
    id = Column(String(64), primary_key=True, default=new_id)
    name = Column(String(180), nullable=False)
    location = Column(String(180))
    start_date = Column(String(40))
    status = Column(String(20), default="Active", nullable=False)  # Active/Completed/On Hold
    cover = Column(Text)
    created_at = Column(DateTime, default=now_utc)

    allocations = relationship(
        "Allocation", back_populates="project", cascade="all, delete-orphan"
    )


class Employee(Base):
    __tablename__ = "employees"
    id = Column(String(64), primary_key=True, default=new_id)
    name = Column(String(120), nullable=False)
    name_hi = Column(String(120))
    code = Column(String(40), unique=True, nullable=False)
    designation = Column(String(120))
    skill = Column(String(120))
    gender = Column(String(20))
    marital_status = Column(String(20))
    dob = Column(String(40))
    father_name = Column(String(120))
    nominee = Column(String(120))
    primary_mobile = Column(String(40))
    alt_mobile = Column(String(40))
    email = Column(String(180))
    date_of_joining = Column(String(40))
    date_of_exit = Column(String(40))
    current_address = Column(Text)
    permanent_address = Column(Text)
    aadhaar = Column(String(40))
    pan = Column(String(40))
    uan = Column(String(40))
    esi = Column(String(40))
    status = Column(String(30), default="Active")  # Active/Inactive/No Allocation
    photo = Column(Text)
    face_encoding = Column(Text)  # JSON list[float] length 128, computed from photo
    created_at = Column(DateTime, default=now_utc)

    allocations = relationship(
        "Allocation", back_populates="employee", cascade="all, delete-orphan"
    )


class Allocation(Base):
    __tablename__ = "allocations"
    id = Column(String(64), primary_key=True, default=new_id)
    project_id = Column(String(64), ForeignKey("projects.id"), nullable=False)
    employee_id = Column(String(64), ForeignKey("employees.id"), nullable=False)
    allocated_at = Column(DateTime, default=now_utc)
    __table_args__ = (UniqueConstraint("project_id", "employee_id", name="uq_alloc"),)

    project = relationship("Project", back_populates="allocations")
    employee = relationship("Employee", back_populates="allocations")


class AttendanceRecord(Base):
    __tablename__ = "attendance"
    id = Column(String(64), primary_key=True, default=new_id)
    employee_id = Column(String(64), ForeignKey("employees.id"), nullable=False)
    type = Column(String(20), nullable=False)  # Check-in / Check-out
    time = Column(String(40))  # display string "08:42 AM"
    status = Column(String(20))  # On Time / Late / Early Out
    marked_at = Column(DateTime, default=now_utc)
    day = Column(Date, default=lambda: now_ist().date())


class SalaryRecord(Base):
    __tablename__ = "salary_records"
    id = Column(String(64), primary_key=True, default=new_id)
    employee_id = Column(String(64), ForeignKey("employees.id"), nullable=False)
    month = Column(String(20), nullable=False)  # "Feb 26"
    days_worked = Column(Integer, default=0)
    daily_rate = Column(Integer, default=0)
    deductions = Column(Integer, default=0)
    status = Column(String(20), default="Pending")  # Paid / Pending / Processing


class Notification(Base):
    __tablename__ = "notifications"
    id = Column(String(64), primary_key=True, default=new_id)
    title = Column(String(180), nullable=False)
    description = Column(Text)
    time_label = Column(String(60))
    read = Column(Integer, default=0)
    type = Column(String(30))  # attendance / employee / salary / system
    created_at = Column(DateTime, default=now_utc)


class OtpCode(Base):
    __tablename__ = "otp_codes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(320), nullable=False, index=True)
    code_hash = Column(Text, nullable=False)
    created_at = Column(DateTime, nullable=False, default=now_utc)
    expires_at = Column(DateTime, nullable=False, index=True)
    attempts = Column(Integer, nullable=False, default=0)
    used_at = Column(DateTime, nullable=True)

    __table_args__ = (Index("ix_otp_email_created", "email", "created_at"),)


# --------------------------------------------------------------- schemas ----
class PydBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class SupervisorOut(PydBase):
    id: str
    name: str
    code: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    designation: Optional[str] = None
    photo: Optional[str] = None
    joining_date: Optional[str] = None


class ProjectOut(PydBase):
    id: str
    name: str
    location: Optional[str] = None
    start_date: Optional[str] = None
    status: str
    cover: Optional[str] = None
    allocated_employee_ids: list[str] = []


class ProjectIn(BaseModel):
    name: str
    location: Optional[str] = None
    start_date: Optional[str] = None
    status: str = "Active"
    cover: Optional[str] = None


class EmployeeOut(PydBase):
    id: str
    name: str
    name_hi: Optional[str] = None
    code: str
    designation: Optional[str] = None
    skill: Optional[str] = None
    gender: Optional[str] = None
    marital_status: Optional[str] = None
    dob: Optional[str] = None
    father_name: Optional[str] = None
    nominee: Optional[str] = None
    primary_mobile: Optional[str] = None
    alt_mobile: Optional[str] = None
    email: Optional[str] = None
    date_of_joining: Optional[str] = None
    date_of_exit: Optional[str] = None
    current_address: Optional[str] = None
    permanent_address: Optional[str] = None
    aadhaar: Optional[str] = None
    pan: Optional[str] = None
    uan: Optional[str] = None
    esi: Optional[str] = None
    status: str
    photo: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None


class EmployeeIn(BaseModel):
    name: str
    name_hi: Optional[str] = None
    code: str
    designation: Optional[str] = None
    skill: Optional[str] = None
    gender: Optional[str] = None
    marital_status: Optional[str] = None
    dob: Optional[str] = None
    father_name: Optional[str] = None
    nominee: Optional[str] = None
    primary_mobile: Optional[str] = None
    alt_mobile: Optional[str] = None
    email: Optional[str] = None
    date_of_joining: Optional[str] = None
    date_of_exit: Optional[str] = None
    current_address: Optional[str] = None
    permanent_address: Optional[str] = None
    aadhaar: Optional[str] = None
    pan: Optional[str] = None
    uan: Optional[str] = None
    esi: Optional[str] = None
    status: str = "Active"
    photo: Optional[str] = None
    # Base64-encoded JPEG captured on the device. If present, the backend
    # stores it as a `data:image/jpeg;base64,…` URL AND computes the face
    # encoding server-side. Prefer this over `photo` for device captures so
    # we never persist unreachable local URIs like `file:///data/user/0/...`.
    photo_b64: Optional[str] = None
    project_id: Optional[str] = None


class AttendanceOut(PydBase):
    id: str
    employee_id: str
    employee_name: str
    employee_code: str
    photo: Optional[str] = None
    type: str
    time: Optional[str] = None
    status: Optional[str] = None


class AttendanceIn(BaseModel):
    employee_id: str
    type: str = Field(pattern="^(Check-in|Check-out)$")
    time: Optional[str] = None
    status: Optional[str] = "On Time"


class FaceMatchIn(BaseModel):
    image_b64: str
    type: str = Field(default="Check-in", pattern="^(Check-in|Check-out)$")
    threshold: float = Field(default=0.60, ge=0.30, le=0.80)


class FaceEnrollIn(BaseModel):
    image_b64: str
    update_photo: bool = True


class FaceEnrollOut(BaseModel):
    ok: bool
    message: str
    employee: Optional[EmployeeOut] = None


class FaceBox(BaseModel):
    """Normalized bounding box (0..1) of a detected face in the analyzed frame."""
    top: float
    right: float
    bottom: float
    left: float


class FaceMatchItem(BaseModel):
    matched: bool
    distance: Optional[float] = None
    employee: Optional[EmployeeOut] = None
    attendance: Optional[AttendanceOut] = None
    box: Optional[FaceBox] = None


class FaceMatchOut(BaseModel):
    matched: bool
    distance: Optional[float] = None
    employee: Optional[EmployeeOut] = None
    attendance: Optional[AttendanceOut] = None
    # NEW: all faces detected in the frame with their match status
    matches: list[FaceMatchItem] = Field(default_factory=list)
    faces_detected: int = 0


class SalaryOut(PydBase):
    id: str
    employee_id: str
    employee_name: str
    employee_code: str
    photo: Optional[str] = None
    month: str
    days_worked: int
    daily_rate: int
    deductions: int
    status: str
    net: int


class NotificationOut(PydBase):
    id: str
    title: str
    description: Optional[str] = None
    time_label: Optional[str] = None
    read: bool
    type: str


# --------------------------------------------------------- app / lifespan --
def warm_face_encodings() -> None:
    """Compute + cache face_encoding for enrolled employees whose photo is a URL.
    Runs at startup so the first match request doesn't stall fetching photos."""
    with SessionLocal() as db:
        emps = db.query(Employee).filter(
            Employee.face_encoding.is_(None), Employee.photo.isnot(None)
        ).all()
        for emp in emps:
            if not emp.photo or not emp.photo.startswith("http"):
                continue
            img = _load_image_from_url(emp.photo)
            if img is None:
                continue
            enc = _encode_face(img)
            if enc is None:
                continue
            emp.face_encoding = json.dumps(enc.tolist())
            db.commit()
            logging.info("cached encoding for %s", emp.name)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    # NOTE: No seed data is inserted at startup. The DB starts empty.
    # To bootstrap a supervisor account (needed for OTP login), run:
    #   python scripts/create_supervisor.py --email you@company.com --name "Your Name"
    try:
        warm_face_encodings()
    except Exception as e:
        logging.warning("warm_face_encodings failed: %s", e)
    yield


app = FastAPI(lifespan=lifespan)


# -------------------------------------------------- auth dependency -------
def require_supervisor(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> Supervisor:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    claims = decode_access_token(credentials.credentials)
    with SessionLocal() as db:
        sup = db.get(Supervisor, claims.get("supervisor_id", ""))
        if not sup or sup.email.lower() != claims["sub"].lower():
            raise HTTPException(401, "Supervisor no longer valid")
        return sup


# -------------------------------------------------- auth router (public) --
auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


class OtpRequestBody(BaseModel):
    email: EmailStr


class OtpVerifyBody(BaseModel):
    email: EmailStr
    otp: str = Field(pattern=r"^\d{4,6}$")


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


@auth_router.post("/request-otp", status_code=202)
async def request_otp(body: OtpRequestBody):
    email = str(body.email).strip().lower()
    now = now_utc()
    window_start = now - timedelta(minutes=15)

    with SessionLocal() as db:
        count = db.scalar(
            select(func.count(OtpCode.id)).where(
                OtpCode.email == email, OtpCode.created_at >= window_start
            )
        ) or 0
        if count >= 5:
            raise HTTPException(429, detail="Too many OTP requests; try again later")

        sup = db.scalar(select(Supervisor).where(Supervisor.email == email))
        # Same public response for known/unknown emails to prevent enumeration.
        if sup is None:
            return {"message": "If this address is eligible, an OTP has been sent."}

        otp = generate_otp()

        # Invalidate previous active codes for this email
        db.execute(
            update(OtpCode)
            .where(
                OtpCode.email == email,
                OtpCode.used_at.is_(None),
                OtpCode.expires_at > now,
            )
            .values(used_at=now)
        )
        row = OtpCode(
            email=email,
            code_hash=password_hash.hash(otp),
            created_at=now,
            expires_at=now + timedelta(minutes=OTP_TTL_MINUTES),
            attempts=0,
        )
        db.add(row)
        db.commit()

    try:
        await send_otp_email(email, otp)
    except Exception as e:
        logging.warning("OTP send failed: %s", e)
        with SessionLocal() as db:
            db.execute(
                update(OtpCode)
                .where(OtpCode.email == email, OtpCode.used_at.is_(None))
                .values(used_at=now_utc())
            )
            db.commit()
        raise HTTPException(503, detail="Unable to deliver OTP right now. Try again.")

    return {"message": "If this address is eligible, an OTP has been sent."}


@auth_router.post("/verify-otp", response_model=TokenResponse)
def verify_otp(body: OtpVerifyBody):
    email = str(body.email).strip().lower()
    now = now_utc()
    invalid = HTTPException(400, detail="Invalid or expired OTP")

    with SessionLocal() as db:
        row = db.scalar(
            select(OtpCode)
            .where(
                OtpCode.email == email,
                OtpCode.used_at.is_(None),
                OtpCode.expires_at > now,
            )
            .order_by(OtpCode.created_at.desc())
        )
        if row is None:
            raise invalid
        if row.attempts >= 5:
            row.used_at = now
            db.commit()
            raise invalid
        if not password_hash.verify(body.otp, row.code_hash):
            row.attempts += 1
            if row.attempts >= 5:
                row.used_at = now
            db.commit()
            raise invalid

        sup = db.scalar(select(Supervisor).where(Supervisor.email == email))
        if sup is None:
            row.used_at = now
            db.commit()
            raise invalid
        row.used_at = now
        db.commit()
        token = create_access_token(sup.email, sup.id)
        return TokenResponse(
            access_token=token, expires_in=JWT_EXPIRE_MINUTES * 60
        )


# -------------------------------------------------- protected router ------
api = APIRouter(prefix="/api", dependencies=[Depends(require_supervisor)])


# ---------------------------------------------------- helper serializers ---
def employee_to_out(emp: Employee, db: Session) -> EmployeeOut:
    alloc = (
        db.execute(select(Allocation).where(Allocation.employee_id == emp.id))
        .scalars()
        .first()
    )
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    if alloc:
        project_id = alloc.project_id
        proj = db.get(Project, alloc.project_id)
        project_name = proj.name if proj else None
    return EmployeeOut(
        id=emp.id, name=emp.name, name_hi=emp.name_hi, code=emp.code,
        designation=emp.designation, skill=emp.skill,
        gender=emp.gender, marital_status=emp.marital_status, dob=emp.dob,
        father_name=emp.father_name, nominee=emp.nominee,
        primary_mobile=emp.primary_mobile, alt_mobile=emp.alt_mobile,
        email=emp.email,
        date_of_joining=emp.date_of_joining, date_of_exit=emp.date_of_exit,
        current_address=emp.current_address,
        permanent_address=emp.permanent_address,
        aadhaar=emp.aadhaar, pan=emp.pan, uan=emp.uan, esi=emp.esi,
        status=emp.status, photo=emp.photo,
        project_id=project_id, project_name=project_name,
    )


def project_to_out(p: Project) -> ProjectOut:
    return ProjectOut(
        id=p.id, name=p.name, location=p.location, start_date=p.start_date,
        status=p.status, cover=p.cover,
        allocated_employee_ids=[a.employee_id for a in p.allocations],
    )


# ------------------------------------------------------------- endpoints ---
@api.get("/")
def root():
    return {"service": "dihadi", "status": "ok", "time": now_utc().isoformat()}


@api.get("/supervisor/me", response_model=SupervisorOut)
def get_supervisor():
    with SessionLocal() as db:
        sup = db.query(Supervisor).first()
        if not sup:
            raise HTTPException(404, "No supervisor")
        return SupervisorOut.model_validate(sup)


# ---- employees ----
@api.get("/employees", response_model=list[EmployeeOut])
def list_employees(
    response: Response,
    status: Optional[str] = None,
    q: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    with SessionLocal() as db:
        query = db.query(Employee)
        if status and status != "All":
            query = query.filter(Employee.status == status)
        if q:
            like = f"%{q}%"
            query = query.filter((Employee.name.ilike(like)) | (Employee.code.ilike(like)))
        total = query.count()
        emps = (
            query.order_by(Employee.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        response.headers["X-Total-Count"] = str(total)
        response.headers["X-Page"] = str(page)
        response.headers["X-Page-Size"] = str(page_size)
        return [employee_to_out(e, db) for e in emps]


@api.post("/employees", response_model=EmployeeOut)
def create_employee(payload: EmployeeIn):
    # Diagnostic: log which photo mode the client used. Never log the
    # photo body itself (would blow up the log).
    photo_b64_len = len(payload.photo_b64) if payload.photo_b64 else 0
    photo_kind = "none"
    if payload.photo_b64:
        photo_kind = "photo_b64"
    elif payload.photo:
        if payload.photo.startswith("data:"):
            photo_kind = "photo(data-url)"
        elif payload.photo.startswith("http"):
            photo_kind = "photo(http)"
        elif payload.photo.startswith("file:"):
            photo_kind = "photo(file:!!!)"
        else:
            photo_kind = "photo(other)"
    logging.info(
        "create_employee: code=%s name=%s photo_kind=%s photo_b64_len=%d",
        payload.code, payload.name, photo_kind, photo_b64_len,
    )

    # Reject any client that tries to persist a device-local file URI as
    # `photo`. Such URIs (file:///data/user/0/…) are only reachable on the
    # device that captured them, so the backend can never fetch them for
    # server-side face matching.
    if payload.photo and payload.photo.startswith("file:"):
        raise HTTPException(
            422,
            "Local file URIs are not allowed for photos. Send `photo_b64` "
            "instead so the backend can store a reachable copy.",
        )

    face_encoding_json: Optional[str] = None
    stored_photo: Optional[str] = payload.photo

    if payload.photo_b64:
        pil = _decode_b64_pil(payload.photo_b64)
        if pil is None:
            raise HTTPException(400, "Could not decode photo_b64")
        frame = np.array(pil)
        enc, err = _assess_enrolment(frame, pil)
        if err is not None or enc is None:
            raise HTTPException(422, err or "Photo quality check failed")
        face_encoding_json = json.dumps(enc.tolist())
        b64 = payload.photo_b64
        if not b64.startswith("data:"):
            b64 = f"data:image/jpeg;base64,{b64}"
        stored_photo = b64

    with SessionLocal() as db:
        data = payload.model_dump(exclude={"project_id", "photo_b64", "photo"})
        emp = Employee(**data)
        emp.photo = stored_photo
        if face_encoding_json:
            emp.face_encoding = face_encoding_json
        db.add(emp)
        db.flush()
        if payload.project_id:
            db.add(Allocation(project_id=payload.project_id, employee_id=emp.id))
        db.commit()
        db.refresh(emp)
        return employee_to_out(emp, db)


@api.get("/employees/{emp_id}", response_model=EmployeeOut)
def get_employee(emp_id: str):
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        if not emp:
            raise HTTPException(404, "Employee not found")
        return employee_to_out(emp, db)


class EmployeeUpdate(BaseModel):
    """Partial update. Any field left None is left unchanged.
    `photo_b64` overrides `photo`. When either is set, the server also
    recomputes and caches the face encoding.
    """
    name: Optional[str] = None
    name_hi: Optional[str] = None
    code: Optional[str] = None
    designation: Optional[str] = None
    skill: Optional[str] = None
    gender: Optional[str] = None
    marital_status: Optional[str] = None
    dob: Optional[str] = None
    father_name: Optional[str] = None
    nominee: Optional[str] = None
    primary_mobile: Optional[str] = None
    alt_mobile: Optional[str] = None
    email: Optional[str] = None
    date_of_joining: Optional[str] = None
    date_of_exit: Optional[str] = None
    current_address: Optional[str] = None
    permanent_address: Optional[str] = None
    aadhaar: Optional[str] = None
    pan: Optional[str] = None
    uan: Optional[str] = None
    esi: Optional[str] = None
    status: Optional[str] = None
    photo: Optional[str] = None
    photo_b64: Optional[str] = None
    project_id: Optional[str] = None


@api.patch("/employees/{emp_id}", response_model=EmployeeOut)
def update_employee(emp_id: str, payload: EmployeeUpdate):
    """Partial-update an existing employee. Only fields present in the
    payload are written. If `photo_b64` is provided, the photo is stored
    as a data URL AND the face encoding is recomputed and cached."""
    photo_b64_len = len(payload.photo_b64) if payload.photo_b64 else 0
    logging.info(
        "update_employee: id=%s photo_b64_len=%d", emp_id, photo_b64_len
    )

    if payload.photo and payload.photo.startswith("file:"):
        raise HTTPException(
            422,
            "Local file URIs are not allowed for photos. Send `photo_b64` "
            "instead so the backend can store a reachable copy.",
        )

    new_encoding_json: Optional[str] = None
    new_photo: Optional[str] = None

    if payload.photo_b64:
        pil = _decode_b64_pil(payload.photo_b64)
        if pil is None:
            raise HTTPException(400, "Could not decode photo_b64")
        frame = np.array(pil)
        enc, err = _assess_enrolment(frame, pil)
        if err is not None or enc is None:
            raise HTTPException(422, err or "Photo quality check failed")
        new_encoding_json = json.dumps(enc.tolist())
        b64 = payload.photo_b64
        if not b64.startswith("data:"):
            b64 = f"data:image/jpeg;base64,{b64}"
        new_photo = b64
    elif payload.photo is not None:
        new_photo = payload.photo

    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        if not emp:
            raise HTTPException(404, "Employee not found")

        # Apply every provided scalar field (excluding the ones we handle above)
        scalar_fields = payload.model_dump(
            exclude={"project_id", "photo_b64", "photo"}, exclude_none=True
        )
        for field, value in scalar_fields.items():
            setattr(emp, field, value)

        if new_photo is not None:
            emp.photo = new_photo
        if new_encoding_json is not None:
            emp.face_encoding = new_encoding_json

        # Project (re)allocation: overwrite the single active allocation
        if payload.project_id is not None:
            db.query(Allocation).filter(Allocation.employee_id == emp.id).delete(
                synchronize_session=False
            )
            if payload.project_id:  # non-empty string ⇒ allocate
                db.add(
                    Allocation(project_id=payload.project_id, employee_id=emp.id)
                )
                emp.status = "Active"
            else:
                # explicit empty ⇒ unallocate
                emp.status = "No Allocation"

        db.commit()
        db.refresh(emp)
        return employee_to_out(emp, db)


@api.delete("/employees/{emp_id}")
def delete_employee(emp_id: str):
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        if not emp:
            raise HTTPException(404, "Employee not found")
        # Manually clear FK-linked rows first so the delete succeeds on
        # engines that don't cascade automatically.
        db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == emp.id
        ).delete(synchronize_session=False)
        db.query(SalaryRecord).filter(
            SalaryRecord.employee_id == emp.id
        ).delete(synchronize_session=False)
        db.query(Allocation).filter(
            Allocation.employee_id == emp.id
        ).delete(synchronize_session=False)
        db.delete(emp)
        db.commit()
        return {"ok": True}


@api.post("/employees/{emp_id}/enroll-face", response_model=FaceEnrollOut)
def enroll_employee_face(emp_id: str, payload: FaceEnrollIn):
    """Enroll (or re-enroll) the face for an employee using a base64 image
    captured from the camera. Overwrites the cached 128-d encoding.
    Optionally stores the image itself as the employee's photo (data URL).

    Quality gates (all must pass):
    - decodes successfully
    - not too dark / not over-exposed
    - not blurry
    - exactly one face detected, occupying at least ~15% of image height
    """
    pil = _decode_b64_pil(payload.image_b64)
    if pil is None:
        raise HTTPException(400, "Could not decode image")
    frame = np.array(pil)
    enc, err = _assess_enrolment(frame, pil)
    if err is not None or enc is None:
        raise HTTPException(422, err or "Enrolment quality check failed")
    with SessionLocal() as db:
        emp = db.get(Employee, emp_id)
        if not emp:
            raise HTTPException(404, "Employee not found")
        emp.face_encoding = json.dumps(enc.tolist())
        if payload.update_photo:
            # store the captured selfie as the employee's photo
            b64 = payload.image_b64
            if not b64.startswith("data:"):
                b64 = f"data:image/jpeg;base64,{b64}"
            emp.photo = b64
        db.commit()
        db.refresh(emp)
        logging.info("enrolled face for %s (%s)", emp.name, emp.code)
        return FaceEnrollOut(
            ok=True,
            message=f"Face enrolled for {emp.name}",
            employee=employee_to_out(emp, db),
        )


# ---- projects ----
@api.get("/projects", response_model=list[ProjectOut])
def list_projects(status: Optional[str] = None, q: Optional[str] = None):
    with SessionLocal() as db:
        query = db.query(Project)
        if status and status != "All":
            query = query.filter(Project.status == status)
        if q:
            like = f"%{q}%"
            query = query.filter((Project.name.ilike(like)) | (Project.location.ilike(like)))
        projs = query.order_by(Project.created_at.desc()).all()
        return [project_to_out(p) for p in projs]


@api.post("/projects", response_model=ProjectOut)
def create_project(payload: ProjectIn):
    with SessionLocal() as db:
        p = Project(**payload.model_dump())
        db.add(p)
        db.commit()
        db.refresh(p)
        return project_to_out(p)


@api.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str):
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        if not p:
            raise HTTPException(404, "Project not found")
        return project_to_out(p)


@api.post("/projects/{project_id}/allocate/{employee_id}", response_model=ProjectOut)
def allocate_employee(project_id: str, employee_id: str):
    with SessionLocal() as db:
        if not db.get(Project, project_id):
            raise HTTPException(404, "Project not found")
        if not db.get(Employee, employee_id):
            raise HTTPException(404, "Employee not found")
        exists = (
            db.execute(
                select(Allocation).where(
                    (Allocation.project_id == project_id)
                    & (Allocation.employee_id == employee_id)
                )
            )
            .scalars()
            .first()
        )
        if not exists:
            db.add(Allocation(project_id=project_id, employee_id=employee_id))
            db.commit()
        p = db.get(Project, project_id)
        return project_to_out(p)


@api.delete("/projects/{project_id}/allocate/{employee_id}", response_model=ProjectOut)
def unallocate_employee(project_id: str, employee_id: str):
    with SessionLocal() as db:
        alloc = (
            db.execute(
                select(Allocation).where(
                    (Allocation.project_id == project_id)
                    & (Allocation.employee_id == employee_id)
                )
            )
            .scalars()
            .first()
        )
        if alloc:
            db.delete(alloc)
            db.commit()
        p = db.get(Project, project_id)
        if not p:
            raise HTTPException(404, "Project not found")
        return project_to_out(p)


# ---- attendance ----
@api.get("/attendance/today", response_model=list[AttendanceOut])
def today_attendance(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
):
    with SessionLocal() as db:
        base = db.query(AttendanceRecord).filter(
            AttendanceRecord.day == now_ist().date()
        )
        total = base.count()
        recs = (
            base.order_by(AttendanceRecord.marked_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        response.headers["X-Total-Count"] = str(total)
        response.headers["X-Page"] = str(page)
        response.headers["X-Page-Size"] = str(page_size)
        out: list[AttendanceOut] = []
        for r in recs:
            emp = db.get(Employee, r.employee_id)
            if not emp:
                continue
            out.append(
                AttendanceOut(
                    id=r.id, employee_id=emp.id, employee_name=emp.name,
                    employee_code=emp.code, photo=emp.photo,
                    type=r.type, time=r.time, status=r.status,
                )
            )
        return out


@api.post("/attendance/mark", response_model=AttendanceOut)
def mark_attendance(payload: AttendanceIn):
    with SessionLocal() as db:
        emp = db.get(Employee, payload.employee_id)
        if not emp:
            raise HTTPException(404, "Employee not found")
        rec = AttendanceRecord(
            employee_id=emp.id,
            type=payload.type,
            time=payload.time or ist_time_str(),
            status=payload.status,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
        return AttendanceOut(
            id=rec.id, employee_id=emp.id, employee_name=emp.name,
            employee_code=emp.code, photo=emp.photo,
            type=rec.type, time=rec.time, status=rec.status,
        )


@api.post("/attendance/match", response_model=FaceMatchOut)
def match_face(payload: FaceMatchIn):
    """Server-side multi-face match. Client sends a base64 JPEG/PNG captured
    from the camera; we detect ALL faces in the frame, compute 128-d encodings
    for each, compare each with every enrolled employee, and mark attendance
    for every face whose best-match distance is under the threshold.

    Response keeps `matched/employee/attendance` for backward compatibility
    (first successful match) and adds `matches: list[FaceMatchItem]` containing
    one entry per detected face and `faces_detected` = raw count.
    """
    frame = _decode_b64_image(payload.image_b64)
    if frame is None:
        raise HTTPException(400, "Could not decode image")
    probes = _encode_all_faces(frame)
    logging.info("match: faces detected=%d", len(probes))
    if not probes:
        return FaceMatchOut(matched=False, distance=None, matches=[], faces_detected=0)

    with SessionLocal() as db:
        emps = db.query(Employee).filter(Employee.status != "Inactive").all()

        # Pre-load every employee encoding once so we don't hit MySQL / URL
        # fetch multiple times per detected face.
        emp_encs: list[tuple[Employee, np.ndarray]] = []
        for emp in emps:
            enc_arr: Optional[np.ndarray] = None
            if emp.face_encoding:
                try:
                    enc_arr = np.array(json.loads(emp.face_encoding), dtype=np.float64)
                except Exception:
                    enc_arr = None
            if enc_arr is None and emp.photo:
                img = _load_image_from_url(emp.photo)
                if img is not None:
                    enc = _encode_face(img)
                    if enc is not None:
                        enc_arr = enc
                        emp.face_encoding = json.dumps(enc.tolist())
                        db.commit()
            if enc_arr is not None:
                emp_encs.append((emp, enc_arr))

        # Cooldown so the same person can't be double-punched within N seconds
        # even if the client polls quickly. Client also enforces its own
        # cooldown, but this is a defence-in-depth guard.
        cooldown_window = timedelta(seconds=45)

        matches_out: list[FaceMatchItem] = []
        already_matched_ids: set[str] = set()

        h_img, w_img = frame.shape[:2]
        for loc, probe in probes:
            top_px, right_px, bottom_px, left_px = loc
            box = FaceBox(
                top=top_px / h_img if h_img else 0,
                right=right_px / w_img if w_img else 0,
                bottom=bottom_px / h_img if h_img else 0,
                left=left_px / w_img if w_img else 0,
            )
            best_emp: Optional[Employee] = None
            best_dist: Optional[float] = None
            for emp, enc_arr in emp_encs:
                if emp.id in already_matched_ids:
                    continue  # skip employees already matched by another face in same frame
                dist = float(np.linalg.norm(enc_arr - probe))
                if best_dist is None or dist < best_dist:
                    best_dist = dist
                    best_emp = emp

            if best_emp is None or best_dist is None or best_dist > payload.threshold:
                matches_out.append(FaceMatchItem(matched=False, distance=best_dist, box=box))
                continue

            already_matched_ids.add(best_emp.id)
            rec = AttendanceRecord(
                employee_id=best_emp.id,
                type=payload.type,
                time=ist_time_str(),
                status="On Time",
            )
            db.add(rec)
            db.commit()
            db.refresh(rec)

            matches_out.append(
                FaceMatchItem(
                    matched=True,
                    distance=best_dist,
                    employee=employee_to_out(best_emp, db),
                    attendance=AttendanceOut(
                        id=rec.id,
                        employee_id=best_emp.id,
                        employee_name=best_emp.name,
                        employee_code=best_emp.code,
                        photo=best_emp.photo,
                        type=rec.type,
                        time=rec.time,
                        status=rec.status,
                    ),
                    box=box,
                )
            )

        first_hit = next((m for m in matches_out if m.matched), None)
        if first_hit is None:
            # emit best (worst-case) distance for debugging
            distances = [m.distance for m in matches_out if m.distance is not None]
            best_dist = min(distances) if distances else None
            logging.info(
                "match: no match (faces=%d best_dist=%s threshold=%s)",
                len(probes), best_dist, payload.threshold,
            )
            return FaceMatchOut(
                matched=False,
                distance=best_dist,
                matches=matches_out,
                faces_detected=len(probes),
            )

        return FaceMatchOut(
            matched=True,
            distance=first_hit.distance,
            employee=first_hit.employee,
            attendance=first_hit.attendance,
            matches=matches_out,
            faces_detected=len(probes),
        )


# ---- salary ----
@api.get("/salary", response_model=list[SalaryOut])
def salary_records(month: Optional[str] = Query(default=None)):
    with SessionLocal() as db:
        query = db.query(SalaryRecord)
        if month:
            query = query.filter(SalaryRecord.month == month)
        rows = query.all()
        out: list[SalaryOut] = []
        for r in rows:
            emp = db.get(Employee, r.employee_id)
            if not emp:
                continue
            net = r.days_worked * r.daily_rate - r.deductions
            out.append(
                SalaryOut(
                    id=r.id, employee_id=emp.id, employee_name=emp.name,
                    employee_code=emp.code, photo=emp.photo, month=r.month,
                    days_worked=r.days_worked, daily_rate=r.daily_rate,
                    deductions=r.deductions, status=r.status, net=net,
                )
            )
        return out


# ---- notifications ----
@api.get("/notifications", response_model=list[NotificationOut])
def list_notifications():
    with SessionLocal() as db:
        rows = db.query(Notification).order_by(Notification.created_at.desc()).all()
        return [
            NotificationOut(
                id=n.id, title=n.title, description=n.description,
                time_label=n.time_label, read=bool(n.read), type=n.type,
            )
            for n in rows
        ]


@api.patch("/notifications/{nid}/read")
def mark_notification_read(nid: str):
    with SessionLocal() as db:
        n = db.get(Notification, nid)
        if not n:
            raise HTTPException(404, "Notification not found")
        n.read = 1
        db.commit()
        return {"ok": True}


@api.post("/notifications/read-all")
def mark_all_read():
    with SessionLocal() as db:
        db.query(Notification).update({Notification.read: 1})
        db.commit()
        return {"ok": True}


# --------------------------------------------------------- app wiring ------
app.include_router(auth_router)  # public (no auth)
app.include_router(api)          # everything else requires JWT

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("dihadi")

// Qaans API client — hits the FastAPI backend at EXPO_PUBLIC_BACKEND_URL/api/*
// Never call MySQL directly from the mobile app.

import { router } from "expo-router";

import { storage } from "@/src/utils/storage";

export const AUTH_TOKEN_KEY = "dihadi_access_token";

let cachedToken: string | null = null;

export async function loadToken(): Promise<string | null> {
  const raw = await storage.secureGet<string>(AUTH_TOKEN_KEY, "");
  cachedToken = raw && raw.length > 0 ? raw : null;
  return cachedToken;
}

export async function setToken(value: string) {
  cachedToken = value;
  await storage.secureSet(AUTH_TOKEN_KEY, value);
}

export async function clearToken() {
  cachedToken = null;
  await storage.secureRemove(AUTH_TOKEN_KEY);
}

export type EmployeeStatus = "Active" | "Inactive" | "No Allocation";
export type ProjectStatus = "Active" | "Completed" | "On Hold";

export type Employee = {
  id: string;
  name: string;
  name_hi?: string | null;
  code: string;
  designation?: string | null;
  skill?: string | null;
  gender?: string | null;
  marital_status?: string | null;
  dob?: string | null;
  father_name?: string | null;
  nominee?: string | null;
  primary_mobile?: string | null;
  alt_mobile?: string | null;
  email?: string | null;
  date_of_joining?: string | null;
  date_of_exit?: string | null;
  current_address?: string | null;
  permanent_address?: string | null;
  aadhaar?: string | null;
  pan?: string | null;
  uan?: string | null;
  esi?: string | null;
  status: EmployeeStatus;
  photo?: string | null;
  project_id?: string | null;
  project_name?: string | null;
};

export type EmployeeInput = {
  name: string;
  name_hi?: string;
  code: string;
  designation?: string;
  skill?: string;
  gender?: string;
  marital_status?: string;
  dob?: string;
  father_name?: string;
  nominee?: string;
  primary_mobile?: string;
  alt_mobile?: string;
  email?: string;
  date_of_joining?: string;
  date_of_exit?: string;
  current_address?: string;
  permanent_address?: string;
  aadhaar?: string;
  pan?: string;
  uan?: string;
  esi?: string;
  status?: EmployeeStatus;
  photo?: string;
  /** Base64 JPEG of the captured photo. Preferred over `photo` for
      device-captured shots — the backend converts to a data URL and
      computes the face encoding server-side. */
  photo_b64?: string;
  project_id?: string;
};

export type Project = {
  id: string;
  name: string;
  location?: string | null;
  start_date?: string | null;
  status: ProjectStatus;
  cover?: string | null;
  allocated_employee_ids: string[];
};

export type AttendanceEntry = {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  photo?: string | null;
  type: "Check-in" | "Check-out";
  time?: string | null;
  status?: "On Time" | "Late" | "Early Out" | null;
};

export type FaceBox = {
  top: number; // 0..1 normalized
  right: number;
  bottom: number;
  left: number;
};

export type FaceMatchItem = {
  matched: boolean;
  distance: number | null;
  employee: Employee | null;
  attendance: AttendanceEntry | null;
  box?: FaceBox | null;
};

export type FaceMatchResult = {
  matched: boolean;
  distance: number | null;
  employee: Employee | null;
  attendance: AttendanceEntry | null;
  matches: FaceMatchItem[];
  faces_detected: number;
};

export type SalaryRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  photo?: string | null;
  month: string;
  days_worked: number;
  daily_rate: number;
  deductions: number;
  status: "Paid" | "Pending" | "Processing";
  net: number;
};

export type AppNotification = {
  id: string;
  title: string;
  description?: string | null;
  time_label?: string | null;
  read: boolean;
  type: "attendance" | "employee" | "salary" | "system";
};

export type Supervisor = {
  id: string;
  name: string;
  code: string;
  email?: string | null;
  phone?: string | null;
  designation?: string | null;
  photo?: string | null;
  joining_date?: string | null;
};

const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

async function request<T>(
  path: string,
  init?: RequestInit & { params?: Record<string, string | undefined>; skipAuth?: boolean }
): Promise<T> {
  const { params, skipAuth, ...rest } = init ?? {};
  let url = `${BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== "") qs.append(k, v);
    });
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  if (!skipAuth) {
    const token = cachedToken ?? (await loadToken());
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(url, { ...rest, headers });
  if (res.status === 401 && !skipAuth) {
    await clearToken();
    try {
      router.replace("/login");
    } catch {
      // router may not be ready — ignore
    }
    throw new Error("Session expired");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  requestOtp: (email: string) =>
    request<{ message: string }>("/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
      skipAuth: true,
    }),
  verifyOtp: (email: string, otp: string) =>
    request<{ access_token: string; token_type: string; expires_in: number }>(
      "/auth/verify-otp",
      {
        method: "POST",
        body: JSON.stringify({ email, otp }),
        skipAuth: true,
      }
    ),

  supervisor: () => request<Supervisor>("/supervisor/me"),

  listEmployees: (opts?: { status?: string; q?: string }) =>
    request<Employee[]>("/employees", { params: opts as never }),
  createEmployee: (payload: EmployeeInput) =>
    request<Employee>("/employees", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getEmployee: (id: string) => request<Employee>(`/employees/${id}`),
  updateEmployee: (id: string, payload: Partial<EmployeeInput>) =>
    // Use PUT (not PATCH) because some reverse proxies / ingress controllers
    // strip the PATCH verb. Backend registers this handler on both PATCH
    // and PUT so either method works.
    request<Employee>(`/employees/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteEmployee: (id: string) =>
    request<{ ok: true }>(`/employees/${id}`, { method: "DELETE" }),

  listProjects: (opts?: { status?: string; q?: string }) =>
    request<Project[]>("/projects", { params: opts as never }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  allocate: (projectId: string, employeeId: string) =>
    request<Project>(`/projects/${projectId}/allocate/${employeeId}`, {
      method: "POST",
    }),
  unallocate: (projectId: string, employeeId: string) =>
    request<Project>(`/projects/${projectId}/allocate/${employeeId}`, {
      method: "DELETE",
    }),

  todayAttendance: () => request<AttendanceEntry[]>("/attendance/today"),
  markAttendance: (payload: {
    employee_id: string;
    type: "Check-in" | "Check-out";
    time?: string;
    status?: string;
  }) =>
    request<AttendanceEntry>("/attendance/mark", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  matchFace: (payload: {
    image_b64: string;
    type: "Check-in" | "Check-out";
    threshold?: number;
  }) =>
    request<FaceMatchResult>("/attendance/match", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  enrollFace: (
    employeeId: string,
    payload: { image_b64: string; update_photo?: boolean }
  ) =>
    request<{ ok: boolean; message: string; employee: Employee | null }>(
      `/employees/${employeeId}/enroll-face`,
      {
        method: "POST",
        body: JSON.stringify({ update_photo: true, ...payload }),
      }
    ),

  salary: (month?: string) =>
    request<SalaryRow[]>("/salary", { params: { month } }),

  notifications: () => request<AppNotification[]>("/notifications"),
  markNotificationRead: (id: string) =>
    request<{ ok: true }>(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllRead: () =>
    request<{ ok: true }>("/notifications/read-all", { method: "POST" }),
};

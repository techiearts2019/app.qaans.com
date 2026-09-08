#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: >
  Face Attendance screen must show a full-screen live camera, automatically mark
  check-in/check-out when a face matches an image stored in the database, keep
  scanning on failed matches, display the matched employee name in English and
  Hindi, and announce the name via Hindi audio (TTS).

backend:
  - task: "POST /api/employees/{emp_id}/enroll-face"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: >
          New endpoint. Accepts {image_b64, update_photo}. Decodes JPEG, runs
          face_recognition.face_encodings, stores 128-d encoding in JSON column
          and (if update_photo=true) overwrites employee.photo with the data URL.
          Requires Bearer auth. Verified locally with /tmp/enroll_smoke.py:
          returns 200 and subsequent /attendance/match returns matched=true dist=0.0.

  - task: "POST /api/attendance/match"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          Distance threshold set to 0.60 (relaxed from 0.55). face_encodings for
          seeded employees are warmed up at app startup (see warm_face_encodings).
          Verified /tmp/enroll_smoke.py end-to-end match works after enrollment.

frontend:
  - task: "Face Attendance auto-detect and mark"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/attendance.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          Poll interval reduced to 1500ms. takePictureAsync captures are
          downscaled to 480px @ JPEG q=0.6 with expo-image-manipulator before
          POST. Match modal auto-dismisses after 3s (hands-free) and 60s
          per-employee cooldown prevents double-punch. Hindi TTS announcement
          via expo-speech remains. Scanning ActivityIndicator surfaces network
          activity.

  - task: "Enroll face flow (in-app)"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/attendance.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          New person-add icon in the Attendance top bar opens a bottom-sheet-
          style modal listing all employees. Picking one and tapping
          "Capture & Enroll" captures the current camera frame, downscales it,
          and POSTs to /api/employees/{id}/enroll-face. On success, the
          employees list is refreshed and the modal closes. Errors (no face
          detected, 422/etc) surface via testID="enroll-error".

metadata:
  created_by: "main_agent"
  version: "1.1"
  test_sequence: 2
  run_ui: true

test_plan:
  current_focus:
    - "Add Employee photo saving (photo_b64 → data URL + face_encoding)"
    - "POST /api/employees create_employee"
    - "Frontend encodePhotoForUpload"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: >
      Please test the newly implemented Enroll Face endpoint and the polished
      Face Attendance screen. Auth credentials for automated testing are in
      /app/memory/test_credentials.md (email techiearts19@gmail.com; OTP row
      can be seeded directly with pwdlib PasswordHash.recommended().hash('123456')).

      Backend focus:
      1) POST /api/employees/{emp_id}/enroll-face
         - Requires Bearer token; 401 without.
         - Rejects payload without a detectable face (422).
         - On success, updates employee.face_encoding (and photo if update_photo=true).
         - Follow-up /api/attendance/match with the SAME base64 payload should return matched=true with distance close to 0.
      2) POST /api/attendance/match unchanged interface, threshold=0.60.

      Frontend focus (Attendance screen):
      1) Full-screen CameraView renders. Status pill shows "Scanning…" and an
         ActivityIndicator flickers while requests are in flight.
      2) Tapping the person-add icon opens the Enroll modal. Picking an
         employee shows the selected row. Tapping "Capture & Enroll"
         (testID="enroll-capture-button") calls the enroll endpoint.
      3) On successful match, the modal appears with English + Hindi names,
         Hindi TTS is announced via expo-speech, and the modal auto-dismisses
         after 3s to resume scanning without user input.
      4) Same employee cannot be re-punched within 60s (cooldownRef).

      Test employee: DHD-1042 (Ramesh Kumar).

  - agent: "main"
    message: >
      Round 3 changes — live face bounding boxes over camera preview.

      BACKEND (server.py):
      1) NEW schema `FaceBox {top,right,bottom,left}` all normalized to 0..1.
      2) Every `FaceMatchItem` now includes an optional `box: FaceBox` computed
         from the raw pixel `face_locations` divided by frame width/height.
      3) Backward compatible: existing clients ignoring `box` still work.

      FRONTEND (attendance.tsx):
      1) `CameraView` captures its rendered size via onLayout.
      2) Every match tick populates `boxes` state from `res.matches`. Each box
         is rendered as an absolutely-positioned rectangle: green + employee
         name for matched, amber + "Unknown" for unmatched.
      3) Front-camera compensation: preview is horizontally mirrored on device
         but the captured image is NOT, so we flip `left/right` when
         `facing === "front"` so the box stays on the actual face.
      4) BOX_TTL_MS = 2200 clears stale boxes when scanning pauses.

      Round 2 context (for reference — previously verified in iteration_2):


      BACKEND (server.py):
      1) POST /api/employees/{emp_id}/enroll-face now runs a quality gate
         BEFORE saving. Rejects with 422 + friendly `detail` when the image is
         too dark, over-exposed, blurry, contains 0 or >1 faces, or the face
         is <15% of the image height. Verified locally with
         /tmp/quality_multi_smoke.py (dark, bright, blur all correctly 422).
      2) POST /api/attendance/match now detects and matches EVERY face in the
         frame (not just the first). Response gained two fields:
           - `faces_detected: int`
           - `matches: FaceMatchItem[]` (one entry per detected face)
         The old `matched/employee/attendance` fields still point at the
         first successful match for backward compatibility.
         `already_matched_ids` prevents the same employee from being punched
         twice within a single frame.

      FRONTEND (attendance.tsx):
      1) The polling handler iterates `res.matches`, applies the 60s
         per-employee cooldown, and queues fresh matches. First match is
         shown immediately; the rest are queued and shown one-after-another
         as the auto-dismiss timer fires (3s each).
      2) Match card badge shows "Attendance marked · N more" when queue > 0.
      3) Enrol modal now surfaces the backend `detail` message directly
         (parses "422 …: {json}") so users see "The image is too dark…"
         instead of raw HTTP text.
      4) Bottom hint switches from "Auto-detecting faces · X employees enrolled"
         to "N face(s) detected · Auto-punching" when faces are in frame.

      Please re-verify with pytest and a UI walk-through:
        - Enrol accepts a good frame, rejects black/white/blurry frames.
        - Match returns `matches` with faces_detected count.
        - When two faces of the same employee are in the frame, only ONE
          attendance record is created (per-frame dedupe).



  - agent: "main"
    message: >
      Round-N bug fix — "Add Employee photo not saved". Reported symptom:
      employee record was created but `photo` and `face_encoding` columns
      remained NULL.

      Root cause (hypothesised): the fluent `ImageManipulator.manipulate()
      .renderAsync().saveAsync({base64:true})` chain silently returned an
      undefined `base64` on some Android APK builds, so the frontend fell
      through and called `createEmployee` without the photo payload.

      Fixes applied:

      BACKEND (server.py) — unchanged from previous iteration:
      - `POST /api/employees` accepts `photo_b64`. When present it decodes,
        runs the enrolment quality gate, computes the 128-d face encoding,
        stores the photo as a `data:image/jpeg;base64,...` URL AND the
        encoding as JSON.
      - `photo` starting with `file:` is rejected with 422.

      FRONTEND (frontend/app/employees/add.tsx):
      - Switched `encodePhotoForUpload()` from the fluent
        `ImageManipulator.manipulate().renderAsync().saveAsync()` chain
        to the legacy `ImageManipulator.manipulateAsync(uri, actions,
        options)` which is more reliable on APK builds.
      - New defensive guard in `onSave`: if `encodePhotoForUpload` throws
        OR returns an empty object, show a toast and DO NOT call
        `createEmployee`. This makes it impossible to create a photo-less
        record when the user selected a photo.
      - Same reliability fix applied to `frontend/app/(tabs)/attendance.tsx`
        (scan loop + enrol modal) for consistency.

      Please verify:
      1) `POST /api/employees` with `photo_b64` returns 200, stored `photo`
         is a `data:image/jpeg;base64,...` URL, `face_encoding` is JSON of
         length ~2777.
      2) `POST /api/employees` with `photo` = "file:///..." returns 422
         with friendly detail.
      3) After creation, `POST /api/attendance/match` with the same base64
         returns `matched=true`, `distance` close to 0, and the newly
         created employee id.
      4) Frontend Add-Employee flow (via UI test IDs) still renders and
         `save-employee-button` triggers a proper POST when photo is set.

      Reference smoke: /tmp/repro_photo_save.py (already re-verified).


  - agent: "main"
    message: >
      User reported: "please fix employee photo is not showing" (screenshot
      showed employees list with no visible avatars at all).

      Investigation:
        - `DHD-2009 Saqib`, `DHD-1005 Saqib Khan`, `QNS-1001 Saqib Khan`
          all have photo=NULL in MySQL (verified via a Python probe against
          the live DB).
        - `<Image source={{ uri: undefined }}>` in expo-image collapses the
          52×52 avatar to zero-height on some builds, which is why the card
          looks broken.

      Fix applied:

      NEW COMPONENT `frontend/src/components/Avatar.tsx`:
        - Renders `<Image>` when photo is http(s):// OR data:image/…;base64,…
        - Falls back to a coloured circle with the person's initials for
          null/undefined/empty photos.
        - Deterministic pastel palette (same name → same colour across screens).

      SCREENS UPDATED (uniformly replaced raw `<Image source={{ uri: emp.photo ?? undefined }}>`):
        - app/employees/index.tsx  (the list from the user's screenshot)
        - app/attendance-records.tsx  (2 places)
        - app/(tabs)/attendance.tsx  (match modal + enrol modal selected + enrol modal list)
        - app/(tabs)/dashboard.tsx  (recent activity)
        - app/projects/[id].tsx  (allocated + roster lists)
        - app/projects/index.tsx  (avatar stack)
        - app/salary-records.tsx

      BACKEND DIAGNOSTIC (server.py):
        - Added a `logging.info` line at the top of `create_employee` that
          reports the photo mode used by the client (`photo_b64`,
          `photo(data-url)`, `photo(http)`, `photo(file:!!!)`, `photo(other)`,
          `none`) and the `photo_b64` length. Never logs the photo body.

      Please verify:
        1) Employees list renders every card with either an image OR the
           initials placeholder — NO collapsed avatar slots even when the
           DB has photo=NULL.
        2) `POST /api/employees` still saves the photo end-to-end
           (regression check for iter-4 fix — the 5 tests in
           `test_create_employee_photo.py` must still be green).
        3) The `Avatar` component correctly distinguishes data URLs, http
           URLs, and null.

# Universal HeadHunter - Functional and Technical Specification

> **This is a generated, readable conversion of the client specification.**
>
> Canonical source: `Universal_HeadHunter_Mobile_Platform_Technical_Specification_EN.docx`
> (client approval version, Tashkent 2026). If the client issues a revised
> .docx, regenerate this file and the copy in the sibling repo together - both
> `headhunter-app/docs/SPEC.md` and `headhunter-backend/docs/SPEC.md` must stay
> in sync with the same source document.
>
> Tables were flattened from Word tables; wording is otherwise verbatim so that
> business rules (BR-nn) and acceptance scenarios (UAT-nn) can be cited exactly.

---
UNIVERSAL HEADHUNTER
Mobile platform for finding workers and specialists
CLIENT FUNCTIONAL AND TECHNICAL SPECIFICATION

| Platforms | Android and iOS mobile applications |
| Technology | Flutter |
| Interface options | O‘zbekcha (Latin), Ўзбекча (Cyrillic), Русский, English |
| Document date | Tashkent, 2026 |

Client approval version

# Document passport

| Item | Description |
| Document purpose | Define the agreed functional scope and acceptance requirements for the first production version of the mobile recruitment platform. |
| Product format | One Flutter mobile application distributed for Android and iOS. |
| User groups | Candidates/workers, employers/recruiters, and platform administrators. |
| Primary use cases | Professional hiring, service and operations roles, physical work, temporary work, seasonal work, and agricultural work. |
| Out of scope | Public website, desktop application, web administration panel, payroll, accounting, in-app salary payments, and built-in video calling. |


# Contents

| Section | Subject |
| 1 | Product purpose and principles |
| 2 | Scope and users |
| 3 | Languages and localization |
| 4 | Authentication and account management |
| 5 | Candidate module |
| 6 | Employer module |
| 7 | Structured candidate search |
| 8 | Vacancies and applications |
| 9 | Communication and notifications |
| 10 | Mobile administration |
| 11 | Business rules and privacy |
| 12 | Technical and non-functional requirements |
| 13 | Acceptance scenarios and deliverables |


# 1. Product purpose and principles
The product shall help employers find candidates that match clearly defined requirements and help candidates discover suitable work opportunities from a single mobile application. The platform shall support both professional occupations and work that is temporary, physical, seasonal, service-based, or agricultural.
Candidate discovery shall not depend only on uploaded CV files. During onboarding and profile editing, the candidate shall provide structured information that can be reliably filtered: occupation, skills, experience, languages, location, availability, desired employment type, expected pay, and job-specific attributes. A CV remains an optional supporting document.

## 1.1. Product principles
All user roles operate within one Android/iOS application.
The interface and navigation change according to the active user role.
Candidate and vacancy matching is based on structured fields and controlled dictionaries.
The same data model supports professional and non-professional work categories.
Candidate privacy settings determine whether a profile can appear in global employer search.
Important employer and vacancy actions are moderated and auditable.

| Example — An employer needing 20 call-centre operators selects the occupation, number of openings, Russian language level C1, location, employment type, and experience requirements. The system returns candidates whose structured profiles satisfy those filters. |


# 2. Scope and users

## 2.1. Supported work categories

| Category | Examples |
| Professional roles | Software developer, accountant, manager, designer, doctor, engineer. |
| Service and operations | Call-centre operator, salesperson, waiter, courier, driver, cleaner. |
| Physical and industrial work | Loader, construction worker, welder, warehouse worker, installer. |
| Seasonal and agricultural work | Planting, harvesting, garden work, livestock assistant, field crew. |
| Temporary and shift work | Daily work, weekly work, fixed-date assignment, replacement worker, shift-based role. |


## 2.2. User roles

| Role | Main capabilities |
| Candidate / worker | Create a searchable profile, upload a CV, browse vacancies, apply, respond to invitations, communicate with employers, and manage privacy. |
| Employer / recruiter | Create a company or individual employer profile, publish vacancies, search candidates, shortlist candidates, manage applications, send invitations, and arrange interviews. |
| Administrator | Verify employers, moderate vacancies, manage dictionaries, review complaints, restrict users, and monitor key product indicators. |


## 2.3. Multi-role account
One account may contain both candidate and employer roles. The user shall switch roles from the profile area without creating a second account. Role-specific data and menus shall remain separated.

## 2.4. Product boundaries
No public website, desktop client, or web administration panel.
No payroll, salary calculation, tax calculation, or employee HR record management.
No transfer of salary or service payments through the application.
No built-in video-conference engine; an external meeting link may be shared.
No automatic verification against government registries unless an official integration is separately approved.
No automatic translation of user-entered profile or vacancy descriptions.

# 3. Languages and localization

## 3.1. Interface variants

| Displayed option | Locale purpose |
| O‘zbekcha (Lotin) | Uzbek language using Latin script. |
| Ўзбекча (Кирилл) | Uzbek language using Cyrillic script. |
| Русский | Russian interface. |
| English | English interface. |

Although the product supports three languages, Uzbek is delivered in two writing systems. Therefore, the application shall contain four selectable interface variants.

## 3.2. Localization rules
The language may be selected before registration and changed later in Settings.
The selected language shall be saved to the user profile and restored on other signed-in devices.
All system labels, buttons, validation messages, statuses, notifications, legal texts, and administrator labels shall be localized.
Occupations, skills, industries, regions, employment types, language names, and other controlled dictionaries shall have values in all four interface variants.
User-generated content shall be displayed as entered. The platform shall not promise automatic translation.
Dates, numbers, currency, plural forms, and text direction shall follow the selected locale. All supported interfaces are left-to-right.
Missing translations must never display technical keys; a configured fallback shall be used and the issue logged.

## 3.3. Search behavior across languages
Search filters shall use dictionary identifiers rather than translated labels. For example, the occupation “Call-centre operator” has one internal identifier and four localized labels. Selecting the occupation in any interface language shall produce the same candidate results.

# 4. Authentication and account management

## 4.1. Registration and sign-in
1. The user selects an interface language.
2. The user enters a phone number and accepts the required terms and privacy notice.
3. The platform sends a one-time password (OTP).
4. The user enters the OTP within the allowed time and attempt limits.
5. The user selects Candidate, Employer, or both roles and continues to the relevant onboarding flow.

## 4.2. Account security
Secure access and refresh tokens.
OTP expiration, resend delay, and attempt limits configured on the server.
Additional confirmation for a new device or phone-number change.
Sign out from the current device and terminate all active sessions.
Account deletion request with confirmation and retention handling according to the approved privacy policy.
Blocked accounts cannot create vacancies, applications, invitations, or messages.

# 5. Candidate / worker module

## 5.1. Candidate onboarding and profile

| Profile section | Required information |
| Personal information | Full name, date of birth, gender, profile photo optional, phone, preferred interface language. |
| Location | Region, district/city, optional current settlement, willingness to travel or relocate. |
| Target work | One or more occupations/work types selected from the dictionary, professional level where applicable. |
| Skills | Skills selected from the dictionary and self-declared proficiency level. |
| Experience | Employer/project, role, start/end dates, responsibilities; simplified entry available for informal or seasonal work. |
| Languages | Language and level A1–C2 or native; certificate details optional. |
| Education | Education level, institution, specialization, graduation year; optional for work categories where it is not relevant. |
| Job preferences | Employment type, work format, shift preferences, expected pay, availability date. |
| Work-specific attributes | Driving licence, vehicle, tools/equipment, readiness for field/physical work, individual or crew work. |
| Privacy | Visible in employer search, hidden from global search, or visible only after applying. |


## 5.2. Dynamic profile fields
The profile form shall adapt to the selected occupation category. Professional roles may request specialization, level, education, and portfolio links. Physical or seasonal work may request availability dates, transport, tools, field-work readiness, and crew information. Irrelevant fields shall not be mandatory.

## 5.3. Profile completeness and visibility
The application shows profile completeness as a percentage.
Missing mandatory fields are listed with direct edit links.
A profile becomes searchable only when minimum required fields are complete and the candidate enables search visibility.
The candidate may hide the profile from global search while continuing to browse and apply to vacancies.
The profile shall show the date of the last meaningful update.

## 5.4. CV and supporting files
Upload, replace, download, and delete a CV in PDF, DOC, or DOCX format.
Upload optional certificates or work evidence using permitted file types.
Display upload progress, success, failure, and retry states.
CV text is not the primary search source; structured profile fields are authoritative for filters.
Files are visible only to authorized employers and administrators.

## 5.5. Candidate home and vacancy discovery
Recommended vacancies based on selected occupations, location, and work preferences.
Recently published vacancies.
Saved vacancies.
Profile completion prompt where relevant.
Vacancy filters: occupation, region, employment type, work format, shift, salary/payment range, experience, language, and publication date.

## 5.6. Vacancy details and applications
Show title, employer, verification status, location, work format, pay, duties, requirements, number of openings, schedule, and application deadline.
Allow Apply, Save, Share, and Report actions.
Prevent more than one active application by the same candidate to the same vacancy.
Show application statuses: Submitted, Viewed, Shortlisted, Interview, Offer, Rejected, Withdrawn, Hired, or Vacancy closed.
Allow withdrawal before an accepted offer, subject to business rules.

# 6. Employer module

## 6.1. Employer profile

| Employer type | Profile information |
| Company / organization | Legal or public name, industry, description, region/address, contact person, phone, logo, verification documents if required. |
| Individual employer | Full name, phone, region, short description of the requested work, identity verification data if required by policy. |

The employer shall see a verification status: Not submitted, Under review, Verified, Rejected, or Changes required. The administrator may request corrections with a reason.

## 6.2. Employer dashboard

| Widget | Content / action |
| Active vacancies | Number of active vacancies and total open positions. |
| New applications | Applications not yet reviewed. |
| Candidates to review | Shortlisted or recently saved candidates. |
| Interviews | Upcoming interview appointments. |
| Invitations | Sent invitations and response counts. |
| Quick actions | Create vacancy and Search candidates. |


## 6.3. Vacancy creation

| Field | Requirement |
| Vacancy category | Professional, service, physical, seasonal/agricultural, temporary, or shift-based. |
| Occupation / work type | Selected from the controlled dictionary. |
| Number of workers | One or more open positions. |
| Description | Responsibilities, work conditions, and concise additional notes. |
| Required skills | One or more skills and required proficiency. |
| Language requirements | Language, required level, and mandatory/preferred flag. |
| Experience and education | Minimum requirements where relevant. |
| Location and work format | Region, district/city, on-site/remote/hybrid where applicable. |
| Schedule | Full-time, part-time, shift, temporary, seasonal; days and hours where known. |
| Salary / payment | Range, daily/monthly/per-task, or negotiable. |
| Dates | Start date or immediately; application deadline. |
| Additional structured requirements | Driving licence, vehicle, tools, field travel, physical readiness, or crew requirement. |


## 6.4. Vacancy statuses

| Status | Meaning |
| Draft | Visible only to the employer and editable. |
| Under moderation | Submitted for administrator review. |
| Active | Visible to candidates and accepting applications. |
| Paused | Temporarily not accepting applications. |
| Closed | Hiring completed or vacancy cancelled. |
| Rejected | Does not meet moderation requirements; reason shown to employer. |


## 6.5. Application management
View applications grouped by vacancy.
Filter by status, location, experience, language level, and application date.
Open the candidate profile and authorized CV.
Move a candidate through the hiring stages.
Add an internal employer note that is not visible to the candidate.
Invite to interview, send an offer, reject with an optional template, or mark as hired.
Show the number of hired/selected candidates against the required worker count.

# 7. Structured candidate search
Verified employers shall be able to search the candidate database without creating a vacancy. When search is opened from a vacancy, the vacancy requirements shall prefill the corresponding filters and remain editable.

## 7.1. Search filters

| Filter group | Available filters |
| Occupation and category | Occupation/work type, industry/category, professional level where applicable. |
| Skills | One or more skills, proficiency, match all or match any. |
| Experience | Total years, years in the selected occupation, current/last role. |
| Languages | Language, A1–C2/native level, certificate availability. |
| Education | Education level and specialization where relevant. |
| Location | Region, district/city, travel/relocation readiness, remote-work readiness. |
| Work preferences | Employment type, work format, shift, expected pay range. |
| Availability | Immediately or from a selected date. |
| Physical/seasonal attributes | Work type, crew readiness, transport, tools, field travel, daily work readiness. |
| Profile status | Search-visible, minimum completeness, recently updated. |
| Conditional filters | Age range and gender only for objectively justified and legally permitted requirements; moderation applies. |


## 7.2. Search interaction
Filters are selected through searchable lists, chips, switches, date pickers, and numeric ranges.
The system shows the current number of matching candidates before the user opens the result list where technically reasonable.
Applied filters are visible as removable chips.
The user can reset all filters or edit a single filter.
The most recently used search configuration may be retained locally for convenience.

## 7.3. Result ranking and candidate card
Sort by overall requirement match, recently updated profile, experience, location proximity where permission exists, or expected pay.
Candidate card shows permitted name, photo if allowed, primary occupation, experience, location, key skills, languages, expected pay, and availability.
Actions: View profile, Save, and Send invitation.
Saved candidates can be attached to a vacancy-specific shortlist and receive a private employer note.

## 7.4. Controlled example: 20 Russian C1 operators
1. Select occupation: Call-centre operator.
2. Set number of openings: 20 in the vacancy.
3. Add mandatory language: Russian, level C1.
4. Select region, experience, employment type, shift, and pay requirements.
5. Open candidate search from the vacancy; filters are prefilled.
6. Review matching candidates, save suitable profiles, and send invitations.
7. Track invited, accepted, interviewed, and hired counts against the target of 20.

## 7.5. Controlled example: workers for one hectare of cotton planting
1. Select category: Seasonal/agricultural work.
2. Select work type: Cotton planting or the approved equivalent dictionary value.
3. Specify region, work date range, worker count, working hours, transport conditions, and payment method.
4. Choose individual workers or crew readiness and any required tools/transport attributes.
5. Publish the vacancy or search visible candidates using the same structured requirements.

# 8. Vacancies, invitations, and hiring stages

## 8.1. Candidate application stages

| Stage | Who can set it | Notification |
| Submitted | Candidate/system | Employer receives a new application notification. |
| Viewed | Employer/system | Candidate may see that the application was viewed. |
| Shortlisted | Employer | Candidate receives a status update. |
| Interview | Employer | Candidate receives date, time, type, and location/link. |
| Offer | Employer | Candidate receives offer details and response actions. |
| Hired | Employer | Both sides see final status. |
| Rejected | Employer | Candidate receives status and optional standard message. |
| Withdrawn | Candidate | Employer sees the withdrawal. |


## 8.2. Direct employer invitation
An employer may invite a search-visible candidate to an active vacancy or send a general work invitation containing occupation, location, schedule, payment, and contact context. The candidate may Accept, Decline, or Request details. Acceptance enables the corresponding communication flow.

## 8.3. Interview scheduling

| Field | Requirement |
| Type | Phone, in-person, or external video link. |
| Date and time | Stored in the configured local time zone and shown clearly. |
| Location / link | Required according to interview type. |
| Instruction | Documents or preparation notes. |
| Candidate response | Confirm or request another time. |


# 9. Communication and notifications

## 9.1. Chat
Chat becomes available after an application, invitation, or other permitted hiring interaction.
Support text messages and approved attachments; voice/video calling is not included.
Show sent, delivered, and read states where supported by the backend.
Allow reporting and blocking according to moderation rules.
Closed or blocked interactions remain in history but may become read-only.

## 9.2. Notifications

| Event | Recipient |
| New application | Employer. |
| Application status changed | Candidate. |
| New invitation or offer | Candidate. |
| Invitation response | Employer. |
| New chat message | Recipient. |
| Interview created or changed | Both parties. |
| Vacancy moderation result | Employer. |
| Employer verification result | Employer. |
| Administrative restriction or complaint decision | Affected user. |

The application shall use in-app notifications and push notifications. Notification settings may allow the user to disable non-critical categories, while security and account notices remain enabled.

# 10. Mobile administration
Administrator functionality shall be provided inside the same mobile application behind an authorized role and protected menu. The scope shall be optimized for mobile use and shall not require a separate web panel.

## 10.1. Administrator dashboard
Total and newly registered candidates and employers.
Profiles awaiting verification.
Vacancies awaiting moderation.
Active vacancies and applications for the selected period.
Open complaints and restricted users.

## 10.2. Verification and moderation
Review company/individual employer information and uploaded evidence.
Approve, reject, or request changes with a mandatory reason.
Review vacancy details, requirements, contact information, and conditional age/gender restrictions.
Approve, reject, pause, or remove a vacancy with an audit record.
Review reported users, vacancies, messages, and profiles.

## 10.3. Dictionary management

| Dictionary | Actions |
| Occupations and work types | Create, edit, activate/deactivate, assign category, maintain localized labels. |
| Skills | Create, edit, categorize, merge duplicates, maintain localized labels. |
| Industries | Create, edit, activate/deactivate, localize. |
| Languages and levels | Manage language list, CEFR levels, and localized display names. |
| Regions | Manage region and district/city hierarchy and localized names. |
| Employment and work attributes | Manage employment types, work formats, shift values, tool/transport attributes. |


## 10.4. User management and audit
Find users by phone, name, role, status, or registration date.
View account status and relevant moderation history.
Warn, temporarily restrict, block, or unblock a user with a reason.
Record important administrator actions in an immutable audit log available to authorized administrators.

# 11. Business rules, privacy, and safety

| ID | Rule |
| BR-01 | A verified phone number is required to use authenticated platform functions. |
| BR-02 | A candidate profile appears in global search only after mandatory fields are complete and visibility is enabled. |
| BR-03 | An employer must complete the employer profile before sending invitations or submitting a vacancy for publication. |
| BR-04 | A vacancy requiring moderation is not visible until approved. |
| BR-05 | The required worker count must be at least one. |
| BR-06 | No new applications are accepted after the application deadline or vacancy closure. |
| BR-07 | One candidate may have only one active application per vacancy. |
| BR-08 | Every application status change is recorded with time and actor. |
| BR-09 | Contact information is revealed according to candidate privacy settings and an allowed hiring interaction. |
| BR-10 | Blocked users cannot create vacancies, applications, invitations, or messages. |
| BR-11 | Closed vacancies are removed from active discovery but retained in account history. |
| BR-12 | Age or gender restrictions require an objective reason, administrator review, and an audit record. |
| BR-13 | System dictionaries use one stable identifier and localized labels for all interface variants. |
| BR-14 | Deletion and retention of user data follow the approved privacy policy and applicable legal requirements. |


## 11.1. Privacy defaults
Phone number and full contact details are not shown in general candidate search cards.
Candidate visibility is controlled by explicit profile settings.
The application requests location permission only when a feature requires it and explains the purpose.
Files are delivered through authorized access and shall not use permanently public links.
Sensitive administrator actions and access to protected data are logged.

# 12. Technical and non-functional requirements

## 12.1. Mobile application
Flutter codebase for Android and iOS.
Adaptive layouts for common phone sizes, system font scaling, safe areas, and platform navigation behavior.
State management, networking, secure token storage, localization, file upload, push notifications, and analytics implemented as maintainable modules.
Release configurations separated for development, testing, and production environments.
Crash reporting and structured application logging without exposing sensitive user data.

## 12.2. Backend and API groups

| API group | Main operations |
| Authentication | Send/verify OTP, sign in, refresh token, sign out, session management. |
| Profiles | Read and update user, candidate, employer, and company profiles. |
| Dictionaries | Retrieve localized occupations, skills, regions, languages, and work attributes. |
| Vacancies | Create, edit, submit, moderate, publish, pause, close, and search. |
| Candidates | Filter candidates, view authorized profiles, save and shortlist. |
| Applications and invitations | Create, list, update status, withdraw, invite, respond. |
| Chat and interviews | Conversations, messages, interview scheduling and responses. |
| Files | Authorized upload, retrieval, replacement, and deletion. |
| Notifications | List, unread count, mark read, preferences. |
| Administration | Verification, moderation, complaints, users, dictionaries, dashboard, audit. |


## 12.3. High-level data objects

| Object | Purpose |
| users and roles | Identity, phone, locale, status, and role assignments. |
| candidate_profiles | Searchable occupation, preferences, availability, privacy, and completeness. |
| candidate_experience / education / skills / languages | Structured candidate qualifications. |
| candidate_files | CV and supporting files with access control. |
| employers / companies | Employer identity, organization details, and verification state. |
| vacancies and requirements | Vacancy information, worker count, structured requirements, and status. |
| applications / invitations / shortlists | Hiring interactions and stage history. |
| chats / messages / interviews | Communication and interview scheduling. |
| notifications | In-app and push notification records. |
| dictionaries and translations | Stable identifiers and labels for all interface variants. |
| complaints / moderation / audit logs | Safety, decisions, and accountability. |


## 12.4. Performance and reliability

| Area | Target |
| Standard API response | At least 95% of normal-load requests complete within 2 seconds, excluding large file transfer. |
| Candidate/vacancy results | First result page returned within 3 seconds under normal load. |
| Mobile navigation | Cached primary screens open without unnecessary blocking; loading states are shown for network data. |
| File upload | Progress, cancellation where supported, failure reason, and retry. |
| Offline behavior | Clear offline state; safe retry without duplicate application, invitation, or message creation. |
| Availability and backups | Production monitoring, scheduled database backups, and documented restore procedure. |


## 12.5. Security
TLS for all network communication.
Server-side role and permission enforcement for every protected API.
Rate limiting for OTP, authentication, search, messaging, and file operations.
Secure storage of secrets and tokens; no secrets embedded in the mobile application.
File-type and size validation, malware scanning where infrastructure permits, and protected download URLs.
Input validation and protection against common API and database attacks.

# 13. Acceptance scenarios and deliverables

## 13.1. User acceptance scenarios

| ID | Scenario | Expected result |
| UAT-01 | A new candidate selects any of the four interface variants, registers by phone and OTP, and enters candidate onboarding. | Account is created; selected locale is retained. |
| UAT-02 | Candidate enters occupation, experience, Russian C1, location, and work preferences. | Profile is saved and becomes searchable when required fields and visibility are complete. |
| UAT-03 | Candidate uploads a PDF CV. | Upload progress is shown; authorized employer can access the file. |
| UAT-04 | Employer creates and submits a company profile. | Verification status and administrator decision are visible. |
| UAT-05 | Verified employer creates a 20-position call-centre vacancy with Russian C1. | Vacancy is stored and becomes active after moderation. |
| UAT-06 | Employer opens candidate search from the vacancy. | Occupation, language, level, location, and other requirements prefill the filters. |
| UAT-07 | Employer saves candidates and sends invitations. | Candidates receive notifications and can respond. |
| UAT-08 | Candidate applies to an active vacancy. | One active application is created and appears for both parties. |
| UAT-09 | Employer moves the application to Interview and creates an appointment. | Candidate sees the new status and interview details. |
| UAT-10 | Employer creates a seasonal cotton-planting vacancy. | Work type, location, dates, worker count, and payment method are saved correctly. |
| UAT-11 | Administrator approves an employer and moderates a vacancy from the mobile admin menu. | Statuses change and the employer receives a notification. |
| UAT-12 | Candidate hides the profile from global search. | The profile no longer appears in new employer searches. |
| UAT-13 | User changes interface from Uzbek Latin to Uzbek Cyrillic, Russian, and English. | All system UI and dictionary labels change; user-entered content remains unchanged. |
| UAT-14 | Administrator temporarily blocks a user. | Restricted operations fail with a clear reason and the action is audited. |
| UAT-15 | A vacancy deadline expires. | New applications are blocked and the vacancy is removed from active discovery. |


## 13.2. Delivery package

| Deliverable | Required content |
| Flutter mobile application | Source code, Android and iOS release configurations, test builds, and release builds. |
| Backend | API source code, database migrations, environment configuration example, and deployment package. |
| API documentation | Swagger/OpenAPI or equivalent current API description. |
| Initial dictionaries | Occupations, skills, work categories, regions, languages, levels, and other approved values with four localized labels. |
| Design files | Final Figma source, components, prototypes, icons/assets, and developer handoff specifications. |
| Technical documentation | Environment setup, deployment, backup, restore, configuration, and support notes. |
| Testing evidence | Functional, integration, and acceptance-test results for agreed scenarios. |


## 13.3. Final acceptance
The product is accepted when the agreed UAT scenarios pass in the test environment, critical and high-severity defects are resolved, the four interface variants are complete, source code and documentation are delivered, and Android/iOS builds can be produced from the delivered project.

# Document approval
The parties confirm that the scope, business rules, mobile-only delivery model, and acceptance criteria described in this document represent the agreed product requirements.

| Party / role | Name | Signature | Date |
| Client representative |  |  |  |
| Contractor representative |  |  |  |
| Product owner |  |  |  |



// The words the face enrollment screens show, kept apart from the screens so the copy rule
// can be checked in node tests (src/enroll/__tests__/copy.test.ts).
/** Every string these screens show, for the copy-rule test. */
export const ENROLL_COPY = {
  consentTitle: 'Your consent',
  consentCheck: 'I consent',
  continue: 'Continue',
  skip: 'Skip for now',
  faceTitle: 'Register face',
  faceBody: 'Follow the prompts on the camera. Use good light and keep your face centered.',
  done: 'Done',
  previewTag: 'Preview',
  settingsTitle: 'Face matching',
  savedTitle: 'Face saved',
  savedBody:
    'Friends in your rooms can challenge you by pointing their camera at you. Only an encrypted template is kept, never your photos.',
  noneTitle: 'No face saved',
  noneBody: 'Friends can still challenge you from the room list.',
  setUp: 'Set up face',
  matchingToggle: 'Face matching',
  faceRow: 'Face',
  savedValue: 'Saved',
  offValue: 'Off',
  deleteButton: 'Delete face data',
  deleteTitle: 'Delete face data?',
  deleteBody:
    "Your face template is erased. Friends can't challenge you by face until you set it up again.",
  deleteYes: 'Yes, delete',
  deleteNo: 'No',
} as const;

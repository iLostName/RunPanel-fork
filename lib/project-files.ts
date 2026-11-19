/**
 * What the file listing of a project answers when there is nothing to list
 * yet: its source was never checked out, or its container never created.
 *
 * That answer used to be an English sentence written for the deploy log,
 * which the File tab printed as an error. It is a code now, sent next to the
 * route's Italian sentence, so the tab can show its own empty state without
 * matching the words of a message. No imports: the route and the tab share it.
 */
export const NO_FILES_YET = "no-source";

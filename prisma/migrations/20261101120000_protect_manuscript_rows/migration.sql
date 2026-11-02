-- Rows that other rows depend on must not be moved or renamed, and the append-only tables must not be emptied.

-- A manuscript belongs to one project and one snapshot for good. Moving it would move its revisions to another snapshot.
CREATE OR REPLACE FUNCTION manuscript_keys_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."snapshotId" IS DISTINCT FROM OLD."snapshotId" THEN
    RAISE EXCEPTION 'Manuscript.projectId and Manuscript.snapshotId cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manuscript_keys_no_change
BEFORE UPDATE ON "Manuscript"
FOR EACH ROW EXECUTE FUNCTION manuscript_keys_immutable();

-- A section keeps its manuscript and its key. Renaming it would hide its history.
CREATE OR REPLACE FUNCTION manuscript_section_keys_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."manuscriptId" IS DISTINCT FROM OLD."manuscriptId" OR NEW."sectionKey" IS DISTINCT FROM OLD."sectionKey" THEN
    RAISE EXCEPTION 'ManuscriptSection.manuscriptId and ManuscriptSection.sectionKey cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manuscript_section_keys_no_change
BEFORE UPDATE ON "ManuscriptSection"
FOR EACH ROW EXECUTE FUNCTION manuscript_section_keys_immutable();

-- The row triggers on ProvenanceEvent and SectionRevision do not fire for TRUNCATE, which empties a table in one statement.
CREATE OR REPLACE FUNCTION append_only_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be truncated', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provenance_event_no_truncate
BEFORE TRUNCATE ON "ProvenanceEvent"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();

CREATE TRIGGER section_revision_no_truncate
BEFORE TRUNCATE ON "SectionRevision"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();

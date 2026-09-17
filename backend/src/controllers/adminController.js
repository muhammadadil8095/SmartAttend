import { db } from "../prisma/db.js";
import bcrypt from "bcryptjs";
import * as xlsx from "xlsx";
// HOD dept resolution now uses JWT claims (req.user.departmentId) set by authMiddleware
import { parseStudentFile } from "../utils/studentFileParser.js";
import { generatePdfTableBuffer } from "../utils/pdfGenerator.js";
import { generateSecureTemporaryCredential } from "../utils/credentialGenerator.js";
import { autoEnrollStudent, autoEnrollStudents } from "../utils/enrollmentHelper.js";

export const getAdminDashboard = async (req, res) => {
  try {
    const students = await db.orm.public.Student.all();
    const faculty = await db.orm.public.Faculty.all();
    const classes = await db.orm.public.Class.all();
    const sessions = await db.orm.public.AttendanceSession.all();
    const attendance = await db.orm.public.Attendance.all();

    // SUPER_ADMIN can see everything.
    // ADMIN/HOD can see only their department.
    let visibleStudents = students;
    let visibleFaculty = faculty;
    let visibleClasses = classes;
    let visibleSessions = sessions;

    if (req.user.role === "ADMIN" || req.user.role === "HOD") {
      if (!req.user.departmentId) {
        return res.status(403).json({
          success: false,
          message: "Admin account is not assigned to a department",
        });
      }

      const departmentId = Number(req.user.departmentId);

      // Department-scoped students
      visibleStudents = students.filter(
        (student) => Number(student.departmentId) === departmentId,
      );

      // Department-scoped faculty
      // Faculty management itself can remain cross-department later,
      // but dashboard faculty count represents faculty belonging to this department.
      visibleFaculty = faculty.filter(
        (member) => Number(member.departmentId) === departmentId,
      );

      // Department-scoped classes
      visibleClasses = classes.filter(
        (classItem) => Number(classItem.departmentId) === departmentId,
      );

      // Sessions belong to classes, so first find this department's class IDs.
      const departmentClassIds = new Set(
        visibleClasses.map((classItem) => Number(classItem.id)),
      );

      visibleSessions = sessions.filter((session) =>
        departmentClassIds.has(Number(session.classId)),
      );
    }

    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split("T")[0];

    const todaySessions = visibleSessions.filter((session) =>
      String(session.sessionDate).startsWith(today),
    );

    const activeSessions = todaySessions.filter(
      (session) => session.endedAt === null,
    );

    // Attendance records belonging to today's sessions
    const todaySessionIds = new Set(
      todaySessions.map((session) => Number(session.id)),
    );

    const todayAttendance = attendance.filter((record) => {
      if (!String(record.markedAt).startsWith(today)) {
        return false;
      }

      // If attendance has a sessionId, use it for department filtering.
      if (record.sessionId !== undefined && record.sessionId !== null) {
        return todaySessionIds.has(Number(record.sessionId));
      }

      // Keep compatibility with existing attendance records.
      return req.user.role === "SUPER_ADMIN";
    });

    const presentToday = todayAttendance.filter(
      (record) => record.status === "PRESENT",
    ).length;

    const absentToday = todayAttendance.filter(
      (record) => record.status === "ABSENT",
    ).length;

    return res.status(200).json({
      success: true,
      data: {
        totalStudents: visibleStudents.length,
        totalFaculty: visibleFaculty.length,
        totalClasses: visibleClasses.length,
        activeSessions: activeSessions.length,
        todaySessions: todaySessions.length,
        todayAttendance: todayAttendance.length,
        presentToday,
        absentToday,
      },
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load admin dashboard",
    });
  }
};

export const getAdminStudents = async (req, res) => {
 try {
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    // SECURITY ENFORCEMENT:
    // If caller is an HOD, their department is strictly locked to their assigned HOD department.
    // They cannot override this by passing ?department=... in the query string.
    let targetDepartment = null;
    if (hodDepartmentId) {
      targetDepartment = hodDepartmentId;
    } else {
      // Non-HOD users (e.g. Super Admin) can optionally filter by query parameter
      targetDepartment = req.query.department || null;
    }

    let result = [];
    let departments = [];

    try {
      const students = await db.orm.public.Student.all();
      const users = await db.orm.public.User.all();
      departments = await db.orm.public.Department.all();
      const devices = await db.orm.public.StudentDevice.all();

      if (students && students.length > 0) {
        result = students.map((student) => {
          const user = users.find((user) => user.id === student.userId);
          const department = departments.find(
            (department) => department.id === student.departmentId
          );
          const studentDevices = devices.filter(
            (device) => device.studentId === student.id && device.isActive === true
          );
          const deviceBound = studentDevices.length > 0;

          return {
            id: student.id,
            name: user?.name ?? "Unknown",
            usn: student.registerNumber,
            department: department?.name ?? "Unknown",
            departmentCode: department?.code ?? null,
            departmentId: student.departmentId,
            semester: student.semester,
            section: student.section,
            Lab: student.Lab || `${student.section || "A"}1`,
            lab: student.Lab || `${student.section || "A"}1`,
            academicYear: student.academicYear,
            email: user?.email ?? null,
            deviceBound,
            boundDeviceName: deviceBound ? "Registered Device" : null,
          };
        });
      }
    } catch (dbErr) {
      // Database offline/unreachable in local dev
    }

    // If database has no records or is unreachable, use comprehensive fallback
    if (!result || result.length === 0) {
      result = [...FALLBACK_STUDENTS];
    }

    // 1. STRICT BACKEND FILTERING: Apply HOD department restriction
    if (targetDepartment) {
      result = result.filter((student) =>
        matchDepartment(student, targetDepartment, departments)
      );
    }

    // 2. SEARCH FILTERING: Apply search within the allowed department subset
    const searchTerm = (req.query.search || req.query.query || req.query.q || "").trim().toLowerCase();
    if (searchTerm) {
      result = result.filter((student) =>
        student.name.toLowerCase().includes(searchTerm) ||
        student.usn.toLowerCase().includes(searchTerm) ||
        String(student.email || "").toLowerCase().includes(searchTerm)
      );
    }

    // 3. USN RANGE & DIVISION FILTERING
    const fromUsn = (req.query.fromUsn || "").trim();
    const toUsn = (req.query.toUsn || "").trim();
    const division = (req.query.division || req.query.section || "").trim().toUpperCase();

    if (fromUsn || toUsn) {
      result = result.filter((student) =>
        checkUsnRange(student.usn, fromUsn, toUsn)
      );
    }

    if (division) {
      result = result.filter((student) =>
        String(student.section || "").toUpperCase() === division
      );
    }

    // Sort students by USN LOW -> HIGH using numeric-aware comparator
    result.sort((a, b) => compareUsn(a.usn, b.usn));

    return res.status(200).json({
      success: true,
      data: result,
      students: result,
      total: result.length,
      isHod: Boolean(hodDepartmentId),
      department: targetDepartment,
    });
  } catch (error) {
    console.error("Admin students error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load students",
    });
  }
};

// Automatically determine the lab batch from the student's USN.
// Every 20 students form one batch:
// 001-020 -> 1
// 021-040 -> 2
// 041-060 -> 3
// 061-080 -> 4
const getAutomaticLabBatch = (usn, section) => {
  const normalizedUsn = String(usn || "")
    .trim()
    .toUpperCase();
  const normalizedSection = String(section || "A")
    .trim()
    .toUpperCase();

  // Extract the numeric suffix from the USN.
  const match = normalizedUsn.match(/(\d+)$/);

  if (!match) {
    return null;
  }

  const usnNumber = parseInt(match[1], 10);

  if (!Number.isFinite(usnNumber) || usnNumber <= 0) {
    return null;
  }

  // 001-020 = 1, 021-040 = 2, etc.
  const batchNumber = Math.ceil(usnNumber / 20);

  // Current Admin system supports maximum 4 batches per division.
  if (batchNumber < 1 || batchNumber > 4) {
    return null;
  }

  return `${normalizedSection}${batchNumber}`;
};

const syncStudentLabBatch = async (student) => {
  try {
    if (!student?.id || !student?.Lab) {
      return null;
    }

    const labBatchName = String(student.Lab).trim().toUpperCase();

    // Find an existing LabBatch for this student's
    // department, semester, section and academic year.
    let labBatch = await db.orm.public.LabBatch.where({
      name: labBatchName,
      departmentId: student.departmentId,
      semester: student.semester,
      section: student.section,
      academicYear: student.academicYear,
    }).all();

    labBatch = labBatch[0] || null;

    // Create the LabBatch automatically if it doesn't exist.
    if (!labBatch) {
      labBatch = await db.orm.public.LabBatch.create({
        name: labBatchName,
        departmentId: student.departmentId,
        semester: student.semester,
        section: student.section,
        academicYear: student.academicYear,
      });

      console.log(
        `Created LabBatch ${labBatchName} for ${student.section}, semester ${student.semester}`,
      );
    }

    // Prevent duplicate StudentBatch records.
    const existingAssignments = await db.orm.public.StudentBatch.where({
      studentId: student.id,
      batchId: labBatch.id,
    }).all();

    if (!existingAssignments.length) {
      await db.orm.public.StudentBatch.create({
        studentId: student.id,
        batchId: labBatch.id,
      });

      console.log(
        `Student ${student.registerNumber} assigned to LabBatch ${labBatchName}`,
      );
    }

    return labBatch;
  } catch (error) {
    console.error(
      `Student lab batch sync failed for ${student?.registerNumber}:`,
      error,
    );

    throw error;
  }
};

const syncStudentEnrollments = async (student) => {
  try {
    const classes = await db.orm.public.Class.where({
      departmentId: student.departmentId,
      semester: student.semester,
      section: student.section,
      academicYear: student.academicYear,
    }).all();

    if (!classes.length) {
      console.log(
        `No matching classes found for student ${student.registerNumber}`,
      );
      return 0;
    }

    const existingEnrollments = await db.orm.public.Enrollment.where({
      studentId: student.id,
    }).all();

    let createdCount = 0;

    for (const classItem of classes) {
      const alreadyEnrolled = existingEnrollments.some(
        (enrollment) => Number(enrollment.classId) === Number(classItem.id),
      );

      if (alreadyEnrolled) {
        continue;
      }

      await db.orm.public.Enrollment.create({
        studentId: student.id,
        classId: classItem.id,
      });

      createdCount++;
    }

    console.log(
      `Enrollment sync: ${student.registerNumber} -> ${createdCount} class(es)`,
    );

    return createdCount;
  } catch (error) {
    console.error(
      `Enrollment sync failed for student ${student.registerNumber}:`,
      error,
    );

    throw error;
  }
};

export const createAdminStudent = async (req, res) => {
  try {
    const {
      name,
      email,
      registerNumber,
      department,
      departmentId,
      semester,
      section,
      academicYear,
    } = req.body;

    // Basic validation
    if (!name || !email || !registerNumber) {
      return res.status(400).json({
        success: false,
        message: "Name, email and register number are required",
      });
    }

    // Find department
    // Find department
    const departments = await db.orm.public.Department.all();

    let selectedDepartment = null;
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    if (hodDepartmentId) {
      if (departmentId && Number(departmentId) !== Number(hodDepartmentId)) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: HOD cannot create students in another department",
        });
      }
      if (department) {
        const bodyDept = resolveDepartment(departments, department);
        if (bodyDept && bodyDept.id !== Number(hodDepartmentId)) {
          return res.status(403).json({
            success: false,
            message: "Forbidden: HOD cannot create students in another department",
          });
        }
      }
      selectedDepartment = resolveDepartment(departments, hodDepartmentId);
    } else if (departmentId) {
      selectedDepartment = departments.find(
        (item) => item.id === Number(departmentId),
      );
    } else if (department) {
      selectedDepartment = departments.find(
        (item) =>
          item.name.toLowerCase() === String(department).trim().toLowerCase() ||
          item.code.toLowerCase() === String(department).trim().toLowerCase(),
      );
    }

    if (!selectedDepartment) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Convert semester if necessary
    const semesterNumber = Number(String(semester ?? "").replace(/\D/g, ""));

    if (!semesterNumber || semesterNumber < 1 || semesterNumber > 8) {
      return res.status(400).json({
        success: false,
        message: "Semester must be between 1 and 8",
      });
    }

    // Normalize values
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedRegisterNumber = String(registerNumber)
      .trim()
      .toUpperCase();

    // Check duplicate email
    const users = await db.orm.public.User.all();

    const emailExists = users.some(
      (user) => user.email.toLowerCase() === normalizedEmail,
    );

    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    // Check duplicate USN
    const students = await db.orm.public.Student.all();

    const registerExists = students.some(
      (student) =>
        student.registerNumber.toUpperCase() === normalizedRegisterNumber,
    );

    if (registerExists) {
      return res.status(409).json({
        success: false,
        message: "Register number already exists",
      });
    }

    // Generate temporary password
    const temporaryPassword = `SA${normalizedRegisterNumber.slice(-4)}@2026`;

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    // Create User
    const user = await db.orm.public.User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      role: "STUDENT",
      isActive: true,
    });

    const cleanSection = section
      ? String(section)
          .replace(/section/i, "")
          .trim()
          .toUpperCase()
      : "A";
    const cleanLab = `${cleanSection}1`;

    // Create Student
    const student = await db.orm.public.Student.create({
      userId: user.id,
      registerNumber: normalizedRegisterNumber,
      departmentId: selectedDepartment.id,
      semester: semesterNumber,
      section: cleanSection,
      Lab: cleanLab,
      academicYear: academicYear || "2026-27",
    });

    // Auto-enroll student into all matching classes
    await autoEnrollStudent(student);

    return res.status(201).json({
      success: true,
      message: "Student account created successfully",
      data: {
        id: student.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        usn: student.registerNumber,
        department: selectedDepartment.name,
        departmentId: selectedDepartment.id,
        semester: student.semester,
        section: student.section,
        academicYear: student.academicYear,
        deviceBound: false,

        // Temporary for development/testing.
        // Remove this before production.
        temporaryPassword,
      },
    });
  } catch (error) {
    console.error("Admin create student error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create student account",
    });
  }
};

export const importAdminStudents = async (req, res) => {
  try {
    const callerRole = req.user?.role;
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    // SECURITY ENFORCEMENT:
    // Department MUST be resolved from the authenticated HOD.
    // Client-supplied department parameter is ignored for HOD callers.
    let targetDepartmentCode = null;

    if (hodDepartmentId) {
      targetDepartmentCode = hodDepartmentId;
    } else if (callerRole === "ADMIN") {
      // Super Admin fallback allows selecting or defaulting department
      targetDepartmentCode = (req.body.department || req.query.department || "CSE").trim().toUpperCase();
    } else {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to import students",
      });
    }

    // Validate uploaded file
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: "Please upload an Excel (.xlsx, .xls), CSV (.csv), or PDF (.pdf) file",
      });
    }

    // Validate Year of Study (1 to 4)
    const rawYear = req.body.year || req.query.year;
    const year = Number(String(rawYear ?? "").replace(/\D/g, ""));

    if (!year || year < 1 || year > 4) {
      return res.status(400).json({
        success: false,
        message: "Year of Study must be selected (1st, 2nd, 3rd, or 4th Year)",
      });
    }

    // Parse the uploaded file (Excel, CSV, or PDF)
    let parsed;
    try {
      parsed = await parseStudentFile(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
    } catch (parseErr) {
      return res.status(400).json({
        success: false,
        message: parseErr.message || "Failed to parse the uploaded file",
      });
    }

    if (!parsed.students || parsed.students.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No student records found in the uploaded file",
      });
    }

    // Find target department in database
    const departments = await db.orm.public.Department.all();
    const targetDept = departments.find(
      (d) =>
        d.code?.toUpperCase() === targetDepartmentCode ||
        d.name?.toUpperCase().includes(targetDepartmentCode)
    );

    if (!targetDept) {
      return res.status(404).json({
        success: false,
        message: `Department ${targetDepartmentCode} not found in database`,
      });
    }

    // Fetch existing records for duplicate detection
    const existingStudents = await db.orm.public.Student.all();
    const existingUsers = await db.orm.public.User.all();

    const existingUsnMap = new Map();
    for (const s of existingStudents) {
      existingUsnMap.set(String(s.registerNumber || "").trim().toUpperCase(), s);
    }

    const existingEmailSet = new Set(
      existingUsers.map((u) => String(u.email || "").trim().toLowerCase())
    );

    // Validate each row and check for duplicates
    const seenUsnsInFile = new Set();
    const evaluatedRows = [];

    for (const student of parsed.students) {
      const usn = String(student.usn || "").trim().toUpperCase();
      const name = String(student.name || "").trim().toUpperCase();

      let status = "READY";
      let reason = null;

      if (student.invalidReason || !usn || !name) {
        status = "INVALID";
        reason = student.invalidReason || (!usn ? "Missing USN" : "Missing student name");
      } else if (seenUsnsInFile.has(usn)) {
        status = "DUPLICATE_IN_FILE";
        reason = "Duplicate USN in uploaded file";
      } else if (existingUsnMap.has(usn)) {
        status = "ALREADY_EXISTS";
        reason = "USN already exists in database";
      } else {
        seenUsnsInFile.add(usn);
      }

      evaluatedRows.push({
        usn,
        name,
        year,
        department: targetDepartmentCode,
        status,
        reason,
      });
    }

    const readyRows = evaluatedRows.filter((r) => r.status === "READY");
    const alreadyExistsRows = evaluatedRows.filter((r) => r.status === "ALREADY_EXISTS");
    const duplicateInFileRows = evaluatedRows.filter((r) => r.status === "DUPLICATE_IN_FILE");
    const invalidRows = evaluatedRows.filter((r) => r.status === "INVALID");

    // Check if this is a Preview request
    const isPreview =
      String(req.query.preview ?? req.body.preview ?? "").toLowerCase() === "true";

    if (isPreview) {
      // PREVIEW STAGE: Return validation analysis WITHOUT modifying database
      return res.status(200).json({
        success: true,
        preview: true,
        department: targetDepartmentCode,
        departmentName: targetDept.name,
        year,
        totalFound: evaluatedRows.length,
        readyToImport: readyRows.length,
        alreadyExists: alreadyExistsRows.length,
        duplicatesInFile: duplicateInFileRows.length,
        invalidRows: invalidRows.length,
        summary: {
          totalFound: evaluatedRows.length,
          readyToImport: readyRows.length,
          alreadyExists: alreadyExistsRows.length,
          duplicatesInFile: duplicateInFileRows.length,
          invalidRows: invalidRows.length,
          department: targetDepartmentCode,
          year,
        },
        students: evaluatedRows,
      });
    }

    // COMMIT STAGE: Insert valid new students into database
    if (readyRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No new or valid students to import. All records already exist or are duplicates.",
        summary: {
          totalFound: evaluatedRows.length,
          readyToImport: 0,
          alreadyExists: alreadyExistsRows.length,
          duplicatesInFile: duplicateInFileRows.length,
          invalidRows: invalidRows.length,
        },
      });
    }

    // Determine semester from year of study:
    // 1st Year -> Semester 1, 2nd Year -> Semester 3, 3rd Year -> Semester 5, 4th Year -> Semester 7
    const semester = year * 2 - 1;
    const insertedStudents = [];

    for (const item of readyRows) {
      let email = `${item.usn.toLowerCase()}@klsvdit.edu.in`;
      if (existingEmailSet.has(email)) {
        email = `${item.usn.toLowerCase()}.${Date.now()}@klsvdit.edu.in`;
      }
      existingEmailSet.add(email);

      const temporaryPassword = `SA${item.usn.slice(-4)}@2026`;
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);

      // 1. Create User account
      const user = await db.orm.public.User.create({
        name: item.name,
        email,
        passwordHash,
        role: "STUDENT",
        isActive: true,
      });

      // 2. Create Student record
      const student = await db.orm.public.Student.create({
        userId: user.id,
        registerNumber: item.usn,
        departmentId: targetDept.id,
        semester,
        section: "A",
        Lab: "A1",
        academicYear: "2026-27",
      });

      insertedStudents.push({
        id: student.id,
        name: user.name,
        usn: student.registerNumber,
        department: targetDepartmentCode,
        departmentId: targetDept.id,
        semester,
        section: "A",
        year,
      });
    }

    // Auto-enroll all newly imported students into matching classes
    await autoEnrollStudents(insertedStudents);

    return res.status(201).json({
      success: true,
      preview: false,
      message: `Successfully imported ${insertedStudents.length} students into ${targetDepartmentCode} (${year} Year).`,
      summary: {
        imported: insertedStudents.length,
        skipped: evaluatedRows.length - insertedStudents.length,
        alreadyExists: alreadyExistsRows.length,
        duplicatesInFile: duplicateInFileRows.length,
        invalidRows: invalidRows.length,
        totalFound: evaluatedRows.length,
        department: targetDepartmentCode,
        year,
      },
      data: insertedStudents,
    });
  } catch (error) {
    console.error("Admin import students error:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while importing students",
    });
  }
};

/**
 * Assign division (A, B, C, D) to students within a USN range.
 * Strictly respects HOD department isolation from verified JWT.
 */
export const assignAdminStudentDivision = async (req, res) => {
  try {
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    // Support both parameter names: startUsn/endUsn or fromUsn/toUsn
    const startUsn = String(req.body.startUsn ?? req.body.fromUsn ?? "").trim().toUpperCase();
    const endUsn = String(req.body.endUsn ?? req.body.toUsn ?? "").trim().toUpperCase();
    const division = String(req.body.division ?? "").trim().toUpperCase();
    const isPreview = String(req.query.preview ?? req.body.preview ?? "").toLowerCase() === "true";

    // 1. Validation: Missing fields
    if (!startUsn) {
      return res.status(400).json({
        success: false,
        message: "Beginning USN is required",
      });
    }

    if (!endUsn) {
      return res.status(400).json({
        success: false,
        message: "Ending USN is required",
      });
    }

    if (!division) {
      return res.status(400).json({
        success: false,
        message: "Division is required (must be A, B, C, or D)",
      });
    }

    // 2. Validation: Division strictly A, B, C, or D
    if (!["A", "B", "C", "D"].includes(division)) {
      return res.status(400).json({
        success: false,
        message: "Invalid division selected. Division must be one of: A, B, C, D",
      });
    }

    // 3. Validation: USN Range ordering and prefix compatibility
    const rangeSpec = parseAndValidateUsnRange(startUsn, endUsn);
    if (!rangeSpec.valid) {
      return res.status(400).json({
        success: false,
        message: rangeSpec.error || "Invalid USN range specification",
      });
    }

    // 4. Resolve target department strictly from authenticated HOD
    const departments = await db.orm.public.Department.all();
    let targetDept = null;
    if (hodDepartmentId) {
      targetDept = resolveDepartment(departments, hodDepartmentId);
    }

    // 5. Query students from database
    const allStudents = await db.orm.public.Student.all();
    const allUsers = await db.orm.public.User.all();

    let targetStudents = allStudents;
    if (targetDept) {
      targetStudents = targetStudents.filter(
        (s) => s.departmentId === targetDept.id
      );
    }

    // Filter students strictly within the validated USN range
    let matchedStudents = targetStudents.filter((s) =>
      checkUsnRange(s.registerNumber, startUsn, endUsn)
    );

    // Fallback in local dev if DB is empty
    if (matchedStudents.length === 0 && (!allStudents || allStudents.length === 0)) {
      let fallbackTarget = [...FALLBACK_STUDENTS];
      if (hodDepartmentId) {
        fallbackTarget = fallbackTarget.filter((s) =>
          matchDepartment(s, hodDepartmentId, departments)
        );
      }
      matchedStudents = fallbackTarget.filter((s) =>
        checkUsnRange(s.usn, startUsn, endUsn)
      );
    }

    if (matchedStudents.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No students found in USN range ${startUsn} to ${endUsn}${targetDept ? ` for department ${targetDept.code}` : ""}.`,
      });
    }

    // Sort matched students by USN LOW -> HIGH
    matchedStudents.sort((a, b) =>
      compareUsn(a.registerNumber || a.usn, b.registerNumber || b.usn)
    );

    // Map matched student details
    const studentSummaries = matchedStudents.map((s) => {
      const u = allUsers.find((user) => user.id === s.userId);
      const willRealignLab = !String(s.Lab || "").startsWith(division);
      return {
        id: s.id,
        usn: s.registerNumber || s.usn,
        name: u?.name || s.name || "Student",
        currentDivision: s.section || "A",
        newDivision: division,
        currentLab: s.Lab || `${s.section || "A"}1`,
        newLab: willRealignLab ? `${division}1` : (s.Lab || `${division}1`),
        semester: s.semester,
      };
    });

    // 6. Preview Mode: Return affected count and student details without modifying DB
    if (isPreview) {
      return res.status(200).json({
        success: true,
        preview: true,
        startUsn,
        endUsn,
        division,
        department: targetDept?.code || hodDepartmentId || "ALL",
        departmentName: targetDept?.name || hodDepartmentId || "All Departments",
        affectedCount: matchedStudents.length,
        students: studentSummaries,
      });
    }

    // 7. Commit Mode: Update each student record in PostgreSQL
    for (const student of matchedStudents) {
      if (student.id) {
        try {
          const updateFields = { section: division };
          // If existing Lab does not match the new division, re-align to default batch (e.g. B1)
          // Preserves the non-null constraint while keeping division and lab strictly consistent
          if (!String(student.Lab || "").startsWith(division)) {
            const defaultLab = `${division}1`;
            updateFields.Lab = defaultLab;
            student.Lab = defaultLab;
          }
          await db.orm.public.Student.where({ id: student.id }).update(updateFields);
          student.section = division;
        } catch (dbUpdateErr) {
          // Fallback update in memory if DB is offline
          student.section = division;
          if (!String(student.Lab || "").startsWith(division)) {
            student.Lab = `${division}1`;
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      preview: false,
      message: `Division ${division} assigned to ${matchedStudents.length} student${matchedStudents.length === 1 ? "" : "s"}.`,
      updatedCount: matchedStudents.length,
      division,
      startUsn,
      endUsn,
      department: targetDept?.code || hodDepartmentId || "ALL",
      students: studentSummaries,
    });
  } catch (error) {
    console.error("Assign student division error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to assign division to students",
    });
  }
};

/**
 * Assign lab batch (A1-A4, B1-B4, C1-C4, D1-D4) to students within a USN range.
 * Updates PostgreSQL Student.Lab directly (SINGLE SOURCE OF TRUTH).
 * Strictly enforces HOD department isolation and division-matching constraints.
 */
export const assignAdminStudentLabBatch = async (req, res) => {
  try {
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    const startUsn = String(req.body.startUsn ?? req.body.fromUsn ?? "").trim().toUpperCase();
    const endUsn = String(req.body.endUsn ?? req.body.toUsn ?? "").trim().toUpperCase();
    const labBatch = String(req.body.labBatch ?? req.body.lab ?? "").trim().toUpperCase();
    const isPreview = String(req.query.preview ?? req.body.preview ?? "").toLowerCase() === "true";

    // 1. Validation: Missing fields
    if (!startUsn) {
      return res.status(400).json({
        success: false,
        message: "Beginning USN is required",
      });
    }

    if (!endUsn) {
      return res.status(400).json({
        success: false,
        message: "Ending USN is required",
      });
    }

    if (!labBatch) {
      return res.status(400).json({
        success: false,
        message: "Lab Batch is required (must be A1-A4, B1-B4, C1-C4, or D1-D4)",
      });
    }

    // 2. Validation: Batch format and max 4 batches per division
    const VALID_LAB_BATCHES = [
      "A1", "A2", "A3", "A4",
      "B1", "B2", "B3", "B4",
      "C1", "C2", "C3", "C4",
      "D1", "D2", "D3", "D4",
    ];

    if (!VALID_LAB_BATCHES.includes(labBatch)) {
      return res.status(400).json({
        success: false,
        message: `Invalid lab batch "${labBatch}". Maximum 4 batches per division allowed: A1-A4, B1-B4, C1-C4, D1-D4.`,
      });
    }

    const targetDivision = labBatch[0]; // e.g. "A" for "A1"

    // 3. Validation: USN Range ordering and prefix compatibility
    const rangeSpec = parseAndValidateUsnRange(startUsn, endUsn);
    if (!rangeSpec.valid) {
      return res.status(400).json({
        success: false,
        message: rangeSpec.error || "Invalid USN range specification",
      });
    }

    // 4. Resolve target department strictly from authenticated HOD
    const departments = await db.orm.public.Department.all();
    let targetDept = null;
    if (hodDepartmentId) {
      targetDept = resolveDepartment(departments, hodDepartmentId);
    }

    // 5. Query students from database
    const allStudents = await db.orm.public.Student.all();
    const allUsers = await db.orm.public.User.all();

    let targetStudents = allStudents;
    if (targetDept) {
      targetStudents = targetStudents.filter(
        (s) => s.departmentId === targetDept.id
      );
    }

    // Filter students strictly within the validated USN range
    let matchedStudents = targetStudents.filter((s) =>
      checkUsnRange(s.registerNumber, startUsn, endUsn)
    );

    // Fallback in local dev if DB is empty
    if (matchedStudents.length === 0 && (!allStudents || allStudents.length === 0)) {
      let fallbackTarget = [...FALLBACK_STUDENTS];
      if (hodDepartmentId) {
        fallbackTarget = fallbackTarget.filter((s) =>
          matchDepartment(s, hodDepartmentId, departments)
        );
      }
      matchedStudents = fallbackTarget.filter((s) =>
        checkUsnRange(s.usn, startUsn, endUsn)
      );
    }

    if (matchedStudents.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No students found in USN range ${startUsn} to ${endUsn}${targetDept ? ` for department ${targetDept.code}` : ""}.`,
      });
    }

    // Sort matched students by USN LOW -> HIGH
    matchedStudents.sort((a, b) =>
      compareUsn(a.registerNumber || a.usn, b.registerNumber || b.usn)
    );

    // 6. CRITICAL DIVISION CONSISTENCY CHECK
    // Every student in the selected range must have section matching the lab batch prefix
    const mismatchedStudents = [];
    const validDivisionStudents = [];

    for (const s of matchedStudents) {
      const studentSec = String(s.section || "").trim().toUpperCase();
      const u = allUsers.find((user) => user.id === s.userId);
      const studentInfo = {
        id: s.id,
        usn: s.registerNumber || s.usn,
        name: u?.name || s.name || "Student",
        section: studentSec,
        currentLab: s.Lab || `${studentSec}1`,
        semester: s.semester,
      };

      if (studentSec !== targetDivision) {
        mismatchedStudents.push(studentInfo);
      } else {
        validDivisionStudents.push(studentInfo);
      }
    }

    const hasMismatch = mismatchedStudents.length > 0;

    // Existing lab assignments breakdown
    let alreadyAssignedCount = 0;
    let reassignedCount = 0;
    const existingBreakdown = {};

    for (const s of matchedStudents) {
      const currentLab = s.Lab || `${s.section || "A"}1`;
      existingBreakdown[currentLab] = (existingBreakdown[currentLab] || 0) + 1;
      if (currentLab === labBatch) {
        alreadyAssignedCount++;
      } else {
        reassignedCount++;
      }
    }

    const studentSummaries = matchedStudents.map((s) => {
      const u = allUsers.find((user) => user.id === s.userId);
      const studentSec = String(s.section || "").trim().toUpperCase();
      return {
        id: s.id,
        usn: s.registerNumber || s.usn,
        name: u?.name || s.name || "Student",
        division: studentSec || "A",
        currentLab: s.Lab || `${studentSec || "A"}1`,
        newLab: labBatch,
        isMismatched: studentSec !== targetDivision,
        semester: s.semester,
      };
    });

    // 7. Preview Mode
    if (isPreview) {
      return res.status(200).json({
        success: true,
        preview: true,
        canApply: !hasMismatch,
        startUsn,
        endUsn,
        labBatch,
        division: targetDivision,
        department: targetDept?.code || hodDepartmentId || "ALL",
        departmentName: targetDept?.name || hodDepartmentId || "All Departments",
        affectedCount: matchedStudents.length,
        alreadyAssignedCount,
        reassignedCount,
        existingBreakdown,
        hasMismatch,
        mismatchedCount: mismatchedStudents.length,
        mismatchedStudents,
        mismatchMessage: hasMismatch
          ? `Range contains ${mismatchedStudents.length} student${mismatchedStudents.length === 1 ? "" : "s"} belonging to a division other than "${targetDivision}". Selected lab batch ${labBatch} can only be assigned to Division ${targetDivision} students.`
          : null,
        students: studentSummaries,
      });
    }

    // 8. Commit Mode (Apply)
    // REJECT if any student in range does not match division
    if (hasMismatch) {
      const firstMismatch = mismatchedStudents[0];
      return res.status(400).json({
        success: false,
        message: `Cannot assign lab batch ${labBatch}: Range contains student ${firstMismatch.usn} (${firstMismatch.name}) belonging to Division "${firstMismatch.section}". All students in the range must belong to Division "${targetDivision}".`,
        mismatchedCount: mismatchedStudents.length,
        mismatchedStudents,
      });
    }

    // Directly update PostgreSQL Student.Lab
    for (const student of matchedStudents) {
      if (student.id) {
        try {
          await db.orm.public.Student.where({ id: student.id }).update({
            Lab: labBatch,
          });
          student.Lab = labBatch;
        } catch (dbUpdateErr) {
          student.Lab = labBatch;
        }
      }
    }

    return res.status(200).json({
      success: true,
      preview: false,
      message: `Lab batch ${labBatch} successfully assigned to ${matchedStudents.length} student${matchedStudents.length === 1 ? "" : "s"} in Division ${targetDivision}.`,
      updatedCount: matchedStudents.length,
      labBatch,
      division: targetDivision,
      startUsn,
      endUsn,
      department: targetDept?.code || hodDepartmentId || "ALL",
      students: studentSummaries,
    });
  } catch (error) {
    console.error("Assign student lab batch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to assign lab batch to students",
    });
  }
};

/**
 * PATCH /api/admin/students/:id
 * Updates an existing student.
 * Only allows editing:
 * 1. name (stored on User model)
 * 2. deviceStatus (stored on StudentDevice model - active or inactive)
 *
 * All other fields (usn, department, departmentId, semester, academicYear, section, role, email, password)
 * are strictly immutable and ignored.
 *
 * HOD department isolation: Caller can only update students belonging to their department.
 */
export const updateAdminStudent = async (req, res) => {
  try {
    const studentId = parseInt(req.params.id, 10);
    if (isNaN(studentId)) {
      return res.status(400).json({ success: false, message: "Invalid student ID" });
    }

    // 1. Verify caller's HOD department scope
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    const students = await db.orm.public.Student.where({ id: studentId }).all();
    if (!students || students.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }
    const student = students[0];

    const departments = await db.orm.public.Department.all();
    const studentDept = departments.find((d) => d.id === student.departmentId);

    if (hodDepartmentId && (!studentDept || !isDepartmentMatch(studentDept, hodDepartmentId))) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot modify students outside your department.",
      });
    }

    // 2. Allow updating editable fields: name, email, usn/registerNumber, section, Lab/labBatch, deviceStatus
    const { name, email, usn, registerNumber, section, lab, Lab, labBatch, semester, deviceStatus } = req.body;
    let updatedName = null;
    let updatedEmail = null;
    let updatedUsn = null;
    let updatedSection = null;
    let updatedLab = null;
    let updatedDeviceStatus = null;

    const userUpdates = {};

    // Update Name on User record if provided
    if (typeof name === "string" && name.trim()) {
      updatedName = name.trim();
      userUpdates.name = updatedName;
    }

    // Update Email on User record if provided (with collision check)
    if (typeof email === "string" && email.trim()) {
      const normalizedEmail = email.trim().toLowerCase();
      const allUsers = await db.orm.public.User.all();
      const duplicateUser = allUsers.find(
        (u) => u.id !== student.userId && u.email.toLowerCase() === normalizedEmail
      );
      if (duplicateUser) {
        return res.status(409).json({
          success: false,
          message: `Email "${normalizedEmail}" is already in use by another account.`,
        });
      }
      updatedEmail = normalizedEmail;
      userUpdates.email = updatedEmail;
    }

    if (Object.keys(userUpdates).length > 0 && student.userId) {
      await db.orm.public.User.where({ id: student.userId }).update(userUpdates);
    }

    // Update Student record fields
    const studentUpdates = {};
    const targetUsn = (registerNumber || usn || "").trim().toUpperCase();
    if (targetUsn && targetUsn !== student.registerNumber) {
      const allStudents = await db.orm.public.Student.all();
      const duplicateStudent = allStudents.find(
        (s) => s.id !== student.id && s.registerNumber.toUpperCase() === targetUsn
      );
      if (duplicateStudent) {
        return res.status(409).json({
          success: false,
          message: `Register Number (USN) "${targetUsn}" is already in use.`,
        });
      }
      studentUpdates.registerNumber = targetUsn;
      updatedUsn = targetUsn;
    }

    if (typeof section === "string" && section.trim()) {
      updatedSection = section.trim().toUpperCase();
      studentUpdates.section = updatedSection;
    }

    const targetLab = (Lab || lab || labBatch || "").trim();
    if (targetLab) {
      updatedLab = targetLab;
      studentUpdates.Lab = updatedLab;
    }

    if (semester !== undefined && semester !== null && !isNaN(Number(semester))) {
      studentUpdates.semester = Number(semester);
    }

    if (Object.keys(studentUpdates).length > 0) {
      await db.orm.public.Student.where({ id: student.id }).update(studentUpdates);

      // Reconcile/auto-enroll in case semester or section was modified
      await autoEnrollStudent({
        id: student.id,
        departmentId: student.departmentId,
        semester: studentUpdates.semester ?? student.semester,
        section: studentUpdates.section ?? student.section,
      });
    }

    // Update Device Status on StudentDevice if provided
    if (deviceStatus !== undefined && deviceStatus !== null) {
      const isRegistered =
        deviceStatus === "Registered" ||
        deviceStatus === true ||
        deviceStatus === "Linked" ||
        deviceStatus === "Active";

      const existingDevices = await db.orm.public.StudentDevice.where({ studentId: student.id }).all();

      if (isRegistered) {
        if (existingDevices.length > 0) {
          // Reactivate existing device
          await db.orm.public.StudentDevice.where({ studentId: student.id }).update({ isActive: true });
          updatedDeviceStatus = "Registered";
        } else {
          // If no mobile device has registered yet, inform caller or maintain consistency
          updatedDeviceStatus = "No Device Bound";
        }
      } else {
        // Deactivate device binding
        if (existingDevices.length > 0) {
          await db.orm.public.StudentDevice.where({ studentId: student.id }).update({ isActive: false });
        }
        updatedDeviceStatus = "Not Registered";
      }
    }

    return res.status(200).json({
      success: true,
      message: "Student updated successfully.",
      data: {
        id: student.id,
        usn: updatedUsn || student.registerNumber,
        name: updatedName,
        email: updatedEmail,
        section: updatedSection || student.section,
        lab: updatedLab || student.Lab,
        deviceStatus: updatedDeviceStatus,
      },
    });
  } catch (error) {
    console.error("Update admin student error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update student",
    });
  }
};


export const getAdminStudentProfile = async (req, res) => {
  try {
    const studentId = Number(req.params.id);

    if (!studentId || Number.isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID",
      });
    }

    const students = await db.orm.public.Student.all();
    const users = await db.orm.public.User.all();
    const departments = await db.orm.public.Department.all();
    const devices = await db.orm.public.StudentDevice.all();
    const attendance = await db.orm.public.Attendance.all();

    const student = students.find((item) => item.id === studentId);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found",
      });
    }

    // Department-level access control
    if (
      (req.user.role === "ADMIN" || req.user.role === "HOD") &&
      Number(student.departmentId) !== Number(req.user.departmentId)
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only access students in your department",
      });
    }

    const user = users.find((item) => item.id === student.userId);

    const department = departments.find(
      (item) => item.id === student.departmentId,
    );

    const studentDevices = devices.filter(
      (device) => device.studentId === student.id,
    );

    const activeDevices = studentDevices.filter(
      (device) => device.isActive === true,
    );

    const studentAttendance = attendance.filter(
      (record) => record.studentId === student.id,
    );

    const totalAttendance = studentAttendance.length;

    const presentAttendance = studentAttendance.filter(
      (record) => record.status === "PRESENT",
    ).length;

    const attendancePercentage =
      totalAttendance > 0
        ? Number(((presentAttendance / totalAttendance) * 100).toFixed(1))
        : 0;

    const activeDevice = activeDevices[0] ?? null;

    return res.status(200).json({
      success: true,
      data: {
        id: student.id,
        userId: student.userId,

        name: user?.name ?? "Unknown",
        email: user?.email ?? null,

        usn: student.registerNumber,

        department: department?.name ?? "Unknown",
        departmentId: student.departmentId,

        semester: student.semester,
        section: student.section,
        academicYear: student.academicYear,

        attendancePercentage,

        deviceBound: activeDevices.length > 0,
        deviceCount: studentDevices.length,
        activeDeviceCount: activeDevices.length,

        device: activeDevice
          ? {
              id: activeDevice.id,
              publicKey: activeDevice.publicKey,
              isActive: activeDevice.isActive,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Admin student profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load student profile",
    });
  }
};

export const unbindAdminStudentDevice = async (req, res) => {
  try {
    const studentId = Number(req.params.id);

    if (!studentId || Number.isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID",
      });
    }

    const students = await db.orm.public.Student.all();

    const student = students.find((item) => item.id === studentId);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found",
      });
    }

    // Department-level access control
    if (
      (req.user.role === "ADMIN" || req.user.role === "HOD") &&
      Number(student.departmentId) !== Number(req.user.departmentId)
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only manage students in your department",
      });
    }

    const devices = await db.orm.public.StudentDevice.where({
      studentId: student.id,
    }).all();

    const activeDevices = devices.filter((device) => device.isActive === true);

    if (activeDevices.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No active device is currently bound to this student",
      });
    }

    let unboundCount = 0;

    for (const device of activeDevices) {
      await db.orm.public.StudentDevice.where({
        id: device.id,
      }).update({
        isActive: false,
      });

      unboundCount++;
    }

    return res.status(200).json({
      success: true,
      message: "Student device binding reset successfully",
      data: {
        studentId: student.id,
        unboundCount,
        deviceBound: false,
      },
    });
  } catch (error) {
    console.error("Admin student device unbind error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to unbind student device",
    });
  }
};

export const getAdminStudentDevice = async (req, res) => {
  try {
    const studentId = Number(req.params.id);

    if (!studentId || Number.isNaN(studentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID",
      });
    }

    const students = await db.orm.public.Student.all();
    const student = students.find((item) => item.id === studentId);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found",
      });
    }

    // Department-level access control
    if (
      (req.user.role === "ADMIN" || req.user.role === "HOD") &&
      Number(student.departmentId) !== Number(req.user.departmentId)
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only manage students in your department",
      });
    }

    const devices = await db.orm.public.StudentDevice.where({
      studentId: student.id,
    }).all();

    const deviceDetails = devices.map((device) => ({
      id: device.id,
      publicKeyFingerprint: device.publicKey
        ? `${device.publicKey.slice(0, 8)}...${device.publicKey.slice(-8)}`
        : "",
      isActive: device.isActive,
      createdAt: device.createdAt,
      updatedAt: device.createdAt,
    }));

    return res.status(200).json({
      success: true,
      data: {
        studentId: student.id,
        usn: student.usn,
        studentName: student.name,
        department: student.departmentId,
        isBound: devices.some((device) => device.isActive === true),
        devices: deviceDetails,
      },
    });
  } catch (error) {
    console.error("Admin student device details error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load student device details",
    });
  }
};

export const getAdminFaculty = async (req, res) => {
  try {
    const faculty = await db.orm.public.Faculty.all();
    const users = await db.orm.public.User.all();
    const departments = await db.orm.public.Department.all();

    const result = faculty.map((member) => {
      const user = users.find((item) => item.id === member.userId);
      const department = departments.find(
        (item) => item.id === member.departmentId,
      );

      return {
        id: member.id,
        userId: member.userId,
        name: user?.name ?? "Unknown",
        email: user?.email ?? null,
        employeeId: member.employeeId,
        department: department?.name ?? "Unknown",
        departmentId: member.departmentId,
        designation: member.designation ?? null,
        isActive: user?.isActive ?? false,
      };
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Admin faculty error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load faculty",
    });
  }
};

export const createAdminFaculty = async (req, res) => {
  try {
    const { name, email, password, employeeId, departmentId, designation } =
      req.body;

    if (!name || !email || !password || !employeeId || !departmentId) {
      return res.status(400).json({
        success: false,
        message:
          "Name, email, password, employee ID and department are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedEmployeeId = String(employeeId).trim().toUpperCase();

    const users = await db.orm.public.User.all();
    const faculty = await db.orm.public.Faculty.all();
    const departments = await db.orm.public.Department.all();

    if (
      users.some(
        (user) => String(user.email).trim().toLowerCase() === normalizedEmail,
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    if (
      faculty.some(
        (member) =>
          String(member.employeeId).trim().toUpperCase() ===
          normalizedEmployeeId,
      )
    ) {
      return res.status(409).json({
        success: false,
        message: "Employee ID already exists",
      });
    }

    const selectedDepartment = departments.find(
      (item) => item.id === Number(departmentId),
    );

    if (!selectedDepartment) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    /*
     * Faculty is intentionally NOT department restricted.
     *
     * A CSE Admin can create an ECE faculty member,
     * because faculty may teach classes belonging to
     * another department.
     */

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await db.orm.public.User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      role: "FACULTY",
      departmentId: selectedDepartment.id,
      isActive: true,
    });

    const facultyRecord = await db.orm.public.Faculty.create({
      userId: user.id,
      employeeId: normalizedEmployeeId,
      departmentId: selectedDepartment.id,
      ...(designation ? { designation: String(designation).trim() } : {}),
    });

    return res.status(201).json({
      success: true,
      message: "Faculty created successfully",
      data: {
        id: facultyRecord.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        employeeId: facultyRecord.employeeId,
        department: selectedDepartment.name,
        departmentId: selectedDepartment.id,
        designation: facultyRecord.designation ?? null,
      },
    });
  } catch (error) {
    console.error("Admin create faculty error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create faculty",
    });
  }
};

export const updateAdminFaculty = async (req, res) => {
  try {
    const facultyId = Number(req.params.id);

    if (!Number.isInteger(facultyId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid faculty ID",
      });
    }

    const { name, employeeId, departmentId, designation } = req.body;

    const [facultyList, users, departments] = await Promise.all([
      db.orm.public.Faculty.all(),
      db.orm.public.User.all(),
      db.orm.public.Department.all(),
    ]);

    const faculty = facultyList.find((item) => item.id === facultyId);

    if (!faculty) {
      return res.status(404).json({
        success: false,
        message: "Faculty not found",
      });
    }

    const user = users.find((item) => item.id === faculty.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Faculty user account not found",
      });
    }

    const allowedDesignations = [
      "HOD",
      "PROFESSOR",
      "ASSOCIATE_PROFESSOR",
      "ASSISTANT_PROFESSOR",
    ];

    if (
      designation !== undefined &&
      !allowedDesignations.includes(designation)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid faculty designation",
      });
    }

    if (employeeId !== undefined) {
      const normalizedEmployeeId = String(employeeId).trim();

      const duplicate = facultyList.find(
        (item) =>
          item.id !== facultyId && item.employeeId === normalizedEmployeeId,
      );

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: "Employee ID already exists",
        });
      }
    }

    let selectedDepartment = null;

    if (departmentId !== undefined) {
      selectedDepartment = departments.find(
        (department) => department.id === Number(departmentId),
      );

      if (!selectedDepartment) {
        return res.status(404).json({
          success: false,
          message: "Department not found",
        });
      }
    } else {
      selectedDepartment = departments.find(
        (department) => department.id === faculty.departmentId,
      );
    }

    const updatedUser = await db.orm.public.User.where({ id: user.id }).update({
      ...(name !== undefined && {
        name: String(name).trim(),
      }),
    });

    const updatedFaculty = await db.orm.public.Faculty.where({
      id: facultyId,
    }).update({
      ...(employeeId !== undefined && {
        employeeId: String(employeeId).trim(),
      }),
      ...(departmentId !== undefined && {
        departmentId: Number(departmentId),
      }),
      ...(designation !== undefined && {
        designation,
      }),
    });

    return res.status(200).json({
      success: true,
      message: "Faculty updated successfully",
      data: {
        id: updatedFaculty.id,
        userId: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        employeeId: updatedFaculty.employeeId,
        designation: updatedFaculty.designation,
        departmentId: updatedFaculty.departmentId,
        department: selectedDepartment?.name ?? "",
        departmentCode: selectedDepartment?.code ?? "",
      },
    });
  } catch (error) {
    console.error("Update admin faculty error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update faculty",
    });
  }
};

export const deleteAdminFaculty = async (req, res) => {
  try {
    const facultyId = Number(req.params.id);

    if (!Number.isInteger(facultyId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid faculty ID",
      });
    }

    const facultyList = await db.orm.public.Faculty.all();

    const faculty = facultyList.find((item) => item.id === facultyId);

    if (!faculty) {
      return res.status(404).json({
        success: false,
        message: "Faculty not found",
      });
    }

    // Do not allow deletion if this faculty is assigned to a class.
    const classes = await db.orm.public.Class.all();

    const assignedClass = classes.find((item) => item.facultyId === facultyId);

    if (assignedClass) {
      return res.status(409).json({
        success: false,
        message:
          "Faculty cannot be deleted because they are assigned to a class",
      });
    }

    await db.orm.public.Faculty.where({ id: facultyId }).delete();

    await db.orm.public.User.where({ id: faculty.userId }).delete();

    return res.status(200).json({
      success: true,
      message: "Faculty deleted successfully",
    });
  } catch (error) {
    console.error("Delete admin faculty error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete faculty",
    });
  }
};


/**
 * GET /api/admin/faculty/export
 * Generates server-side authorized exports (PDF, XLS, XLSX) for faculty.
 * Respects search, department filter, DEAN filter, and strict HOD isolation.
 * Columns: Faculty Name, Employee ID, Department, Designation (Status is omitted).
 */
export const exportAdminFaculty = async (req, res) => {
  try {
    const isAdmin = req.user?.role === "ADMIN" || req.user?.role === "SUPER_ADMIN";
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    const hodDepartmentId = req.user?.departmentId ?? null;
    const isHod = Boolean(hodDepartmentId);

    if (!isAdmin && !isHod) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to export faculty records.",
      });
    }

    let targetDepartment = null;
    if (hodDepartmentId) {
      targetDepartment = hodDepartmentId;
    } else {
      const queryDept = (req.query.department || "").trim().toUpperCase();
      if (queryDept && queryDept !== "ALL" && queryDept !== "DEAN" && queryDept !== "ALL DEPARTMENTS") {
        targetDepartment = queryDept;
      }
    }

    const isDeanFilter =
      String(req.query.filter || req.query.department || "").trim().toUpperCase() === "DEAN" ||
      String(req.query.isDean || "").toLowerCase() === "true";

    const faculties = await db.orm.public.Faculty.all();
    const users = await db.orm.public.User.all();
    const departments = await db.orm.public.Department.all();

    let list = (faculties || []).map((f) => {
      const u = users.find((user) => user.id === f.userId);
      const d = departments.find((dept) => dept.id === f.departmentId);
      return {
        name: u?.name || "Unknown",
        employeeId: f.employeeId,
        department: d?.name || "Unknown",
        departmentCode: d?.code || "Unknown",
        designation: f.designation || "N/A",
      };
    });

    if (targetDepartment) {
      list = list.filter(
        (f) =>
          f.departmentCode.toUpperCase() === targetDepartment.toUpperCase() ||
          f.department.toLowerCase().includes(targetDepartment.toLowerCase())
      );
    }

    if (isDeanFilter) {
      list = list.filter(
        (f) => f.designation && String(f.designation).toLowerCase().includes("dean")
      );
    }

    const searchTerm = (req.query.search || req.query.query || req.query.q || "")
      .trim()
      .toLowerCase();
    if (searchTerm) {
      list = list.filter(
        (f) =>
          f.name.toLowerCase().includes(searchTerm) ||
          f.employeeId.toLowerCase().includes(searchTerm) ||
          f.department.toLowerCase().includes(searchTerm) ||
          f.departmentCode.toLowerCase().includes(searchTerm) ||
          f.designation.toLowerCase().includes(searchTerm)
      );
    }

    list.sort((a, b) => a.name.localeCompare(b.name));

    const format = String(req.query.format || "xlsx").toLowerCase();
    const timestamp = new Date().toISOString().split("T")[0];
    const deptTag = targetDepartment || (isDeanFilter ? "DEAN" : "all");

    if (format === "pdf") {
      const columns = [
        { label: "Faculty Name", width: 170 },
        { label: "Employee ID", width: 90 },
        { label: "Department", width: 150 },
        { label: "Designation", width: 110 },
      ];
      const rows = list.map((f) => [f.name, f.employeeId, f.department, f.designation]);
      const subtitle = `Filter: ${isDeanFilter ? "Dean Category" : targetDepartment || "All Departments"} | Date: ${timestamp} | Total: ${list.length} records`;

      const pdfBuffer = await generatePdfTableBuffer({
        title: "SmartAttend - Faculty Directory",
        subtitle,
        columns,
        rows,
        orientation: "portrait",
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="faculty_${deptTag}_${timestamp}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    // Excel export (XLS or XLSX)
    const headerRow = ["Faculty Name", "Employee ID", "Department", "Designation"];
    const aoa = [
      headerRow,
      ...list.map((f) => [f.name, f.employeeId, f.department, f.designation]),
    ];

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    xlsx.utils.book_append_sheet(wb, ws, "Faculty");

    if (format === "xls") {
      const xlsBuffer = xlsx.write(wb, { type: "buffer", bookType: "biff8" });
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="faculty_${deptTag}_${timestamp}.xls"`
      );
      return res.send(xlsBuffer);
    }

    // Default XLSX
    const xlsxBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="faculty_${deptTag}_${timestamp}.xlsx"`
    );
    return res.send(xlsxBuffer);
  } catch (error) {
    console.error("Export admin faculty error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to export faculty records",
    });
  }
};

/**
 * GET /api/admin/students/export
 * Generates server-side authorized exports (PDF, XLS, XLSX) for students.
 * Preserves USN numeric LOW -> HIGH sorting, division, lab batch, and strict HOD isolation.
 * Columns: USN, Student Name, Department, Semester, Section, Lab Batch, Academic Year, Email, Device Status.
 */
export const exportAdminStudents = async (req, res) => {
  try {
    // HOD dept resolved from JWT claim (DB-authoritative, set by authMiddleware)
    // null = SUPER_ADMIN/institution-wide; number = HOD locked to that departmentId
    const hodDepartmentId = req.user?.departmentId ?? null;

    const students = await db.orm.public.Student.all();
    const users = await db.orm.public.User.all();
    const departments = await db.orm.public.Department.all();
    const devices = await db.orm.public.StudentDevice.all();

    let targetDepartment = null;
    if (hodDepartmentId) {
      const deptObj = resolveDepartment(departments, hodDepartmentId);
      targetDepartment = deptObj?.code || String(hodDepartmentId);
    } else {
      const queryDept = (req.query.department || "").trim().toUpperCase();
      if (queryDept && queryDept !== "ALL" && queryDept !== "ALL DEPARTMENTS") {
        targetDepartment = queryDept;
      }
    }

    let list = (students || []).map((s) => {
      const u = users.find((user) => user.id === s.userId);
      const d = departments.find((dept) => dept.id === s.departmentId);
      const bound = devices.some((dev) => dev.studentId === s.id && dev.isActive === true);
      return {
        usn: s.registerNumber,
        name: u?.name || "Unknown",
        department: d?.name || "Unknown",
        departmentCode: d?.code || "Unknown",
        departmentId: s.departmentId,
        semester: s.semester,
        section: s.section || "A",
        lab: s.Lab || `${s.section || "A"}1`,
        academicYear: s.academicYear || "2026-27",
        email: u?.email || "",
        deviceStatus: bound ? "Registered" : "Not Registered",
      };
    });

    // 1. Department Filter / HOD Isolation
    if (targetDepartment) {
      list = list.filter((s) =>
        matchDepartment(s, targetDepartment, departments)
      );
    }

    // 2. Division / Section Filter
    const sectionFilter = (req.query.section || req.query.division || "").trim().toUpperCase();
    if (sectionFilter) {
      list = list.filter((s) => s.section === sectionFilter);
    }

    // 3. Lab Batch Filter
    const labFilter = (req.query.lab || req.query.labBatch || "").trim().toUpperCase();
    if (labFilter) {
      list = list.filter((s) => s.lab === labFilter);
    }

    // 4. Search Filter
    const searchTerm = (req.query.search || req.query.query || req.query.q || "")
      .trim()
      .toLowerCase();
    if (searchTerm) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(searchTerm) ||
          s.usn.toLowerCase().includes(searchTerm) ||
          s.email.toLowerCase().includes(searchTerm)
      );
    }

    // 5. Sort by USN LOW -> HIGH numeric-aware
    list.sort((a, b) => compareUsn(a.usn, b.usn));

    const format = String(req.query.format || "xlsx").toLowerCase();
    const timestamp = new Date().toISOString().split("T")[0];
    const deptTag = targetDepartment || "all";

    if (format === "pdf") {
      const columns = [
        { label: "USN", width: 80 },
        { label: "Student Name", width: 140 },
        { label: "Department", width: 110 },
        { label: "Sem", width: 35 },
        { label: "Sec", width: 35 },
        { label: "Lab", width: 40 },
        { label: "Academic Year", width: 80 },
      ];
      const rows = list.map((s) => [
        s.usn,
        s.name,
        s.departmentCode || s.department,
        String(s.semester),
        s.section,
        s.lab,
        s.academicYear,
      ]);
      const subtitle = `Department: ${targetDepartment || "All"} | Date: ${timestamp} | Total: ${list.length} students (Sorted USN Low -> High)`;

      const pdfBuffer = await generatePdfTableBuffer({
        title: "SmartAttend - Student Directory",
        subtitle,
        columns,
        rows,
        orientation: "portrait",
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="students_${deptTag}_${timestamp}.pdf"`
      );
      return res.send(pdfBuffer);
    }

    // Excel export (XLS or XLSX)
    const headerRow = [
      "USN",
      "Student Name",
      "Department",
      "Semester",
      "Section",
      "Lab Batch",
      "Academic Year",
      "Email",
      "Device Status",
    ];
    const aoa = [
      headerRow,
      ...list.map((s) => [
        s.usn,
        s.name,
        s.department,
        s.semester,
        s.section,
        s.lab,
        s.academicYear,
        s.email,
        s.deviceStatus,
      ]),
    ];

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    xlsx.utils.book_append_sheet(wb, ws, "Students");

    if (format === "xls") {
      const xlsBuffer = xlsx.write(wb, { type: "buffer", bookType: "biff8" });
      res.setHeader("Content-Type", "application/vnd.ms-excel");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="students_${deptTag}_${timestamp}.xls"`
      );
      return res.send(xlsBuffer);
    }

    // Default XLSX
    const xlsxBuffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="students_${deptTag}_${timestamp}.xlsx"`
    );
    return res.send(xlsxBuffer);
  } catch (error) {
    console.error("Export admin students error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to export student records",
    });
  }
};
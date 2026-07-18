#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if !defined(__linux__) && !defined(__APPLE__)
#error "file-capability-helper supports only Linux and macOS"
#endif

#if !defined(O_CLOEXEC) || !defined(O_DIRECTORY) || !defined(O_NOFOLLOW)
#error "required secure open flags are unavailable"
#endif

#define CAP_PATH_MAX 4096U
#define CAP_NAME_MAX 255U
#define CAP_COMPONENT_MAX 256U
#define COPY_BUFFER_SIZE (64U * 1024U)
#define MAX_FILE_BYTES (UINT64_C(8) * 1024U * 1024U * 1024U)

typedef enum {
  RESULT_OK = 0,
  RESULT_INVALID_REQUEST = 10,
  RESULT_INVALID_PATH = 11,
  RESULT_IDENTITY_MISMATCH = 12,
  RESULT_PATH_EXISTS = 13,
  RESULT_TARGET_CHANGED = 14,
  RESULT_SOURCE_INVALID = 15,
  RESULT_FILE_TOO_LARGE = 16,
  RESULT_IO_ERROR = 17,
  RESULT_COMMIT_INDETERMINATE = 19
} result_code;

static const char *result_name(result_code result) {
  switch (result) {
    case RESULT_OK: return "ok";
    case RESULT_INVALID_REQUEST: return "invalid-request";
    case RESULT_INVALID_PATH: return "invalid-path";
    case RESULT_IDENTITY_MISMATCH: return "identity-mismatch";
    case RESULT_PATH_EXISTS: return "path-exists";
    case RESULT_TARGET_CHANGED: return "target-changed";
    case RESULT_SOURCE_INVALID: return "source-invalid";
    case RESULT_FILE_TOO_LARGE: return "file-too-large";
    case RESULT_IO_ERROR: return "io-error";
    case RESULT_COMMIT_INDETERMINATE: return "commit-indeterminate";
  }
  return "io-error";
}

static int close_nointr(int fd) {
  int result = close(fd);
  return result;
}

static int open_nointr(const char *path, int flags) {
  int fd;
  do {
    fd = open(path, flags);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int openat_nointr(int directory_fd, const char *path, int flags, mode_t mode) {
  int fd;
  do {
    fd = openat(directory_fd, path, flags, mode);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int fstat_nointr(int fd, struct stat *status) {
  int result;
  do {
    result = fstat(fd, status);
  } while (result < 0 && errno == EINTR);
  return result;
}

static int fstatat_nointr(int directory_fd, const char *name, struct stat *status, int flags) {
  int result;
  do {
    result = fstatat(directory_fd, name, status, flags);
  } while (result < 0 && errno == EINTR);
  return result;
}

static int fsync_nointr(int fd) {
  int result;
  do {
    result = fsync(fd);
  } while (result < 0 && errno == EINTR);
  return result;
}

static int unlinkat_nointr(int directory_fd, const char *name) {
  int result;
  do {
    result = unlinkat(directory_fd, name, 0);
  } while (result < 0 && errno == EINTR);
  return result;
}

static size_t bounded_length(const char *value, size_t maximum) {
  size_t length = 0;
  while (length < maximum && value[length] != '\0') length += 1U;
  return length;
}

static bool strict_basename(const char *name) {
  size_t length = bounded_length(name, CAP_NAME_MAX + 1U);
  return length > 0U
    && length <= CAP_NAME_MAX
    && !(length == 1U && name[0] == '.')
    && !(length == 2U && name[0] == '.' && name[1] == '.')
    && strchr(name, '/') == NULL;
}

static result_code copy_component(const char *start, size_t length, char component[CAP_NAME_MAX + 1U]) {
  if (length == 0U || length > CAP_NAME_MAX) return RESULT_INVALID_PATH;
  memcpy(component, start, length);
  component[length] = '\0';
  return strict_basename(component) ? RESULT_OK : RESULT_INVALID_PATH;
}

static result_code open_directory_components(const char *absolute_path, int *directory_fd) {
  size_t length = bounded_length(absolute_path, CAP_PATH_MAX + 1U);
  if (length == 0U || length > CAP_PATH_MAX || absolute_path[0] != '/') return RESULT_INVALID_PATH;
  if (length > 1U && absolute_path[length - 1U] == '/') return RESULT_INVALID_PATH;

  int current = open_nointr("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) return RESULT_IO_ERROR;
  if (length == 1U) {
    *directory_fd = current;
    return RESULT_OK;
  }

  size_t cursor = 1U;
  size_t components = 0U;
  while (cursor < length) {
    const size_t start = cursor;
    while (cursor < length && absolute_path[cursor] != '/') cursor += 1U;
    char component[CAP_NAME_MAX + 1U];
    result_code result = copy_component(absolute_path + start, cursor - start, component);
    if (result != RESULT_OK || ++components > CAP_COMPONENT_MAX) {
      (void)close_nointr(current);
      return RESULT_INVALID_PATH;
    }
    int next = openat_nointr(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0);
    if (next < 0) {
      (void)close_nointr(current);
      return RESULT_INVALID_PATH;
    }
    (void)close_nointr(current);
    current = next;
    if (cursor < length) {
      cursor += 1U;
      if (cursor == length || absolute_path[cursor] == '/') {
        (void)close_nointr(current);
        return RESULT_INVALID_PATH;
      }
    }
  }
  *directory_fd = current;
  return RESULT_OK;
}

static result_code split_file_path(
  const char *file_path,
  char parent[CAP_PATH_MAX + 1U],
  char basename[CAP_NAME_MAX + 1U]
) {
  size_t length = bounded_length(file_path, CAP_PATH_MAX + 1U);
  if (length < 2U || length > CAP_PATH_MAX || file_path[0] != '/' || file_path[length - 1U] == '/') {
    return RESULT_INVALID_PATH;
  }
  const char *last_slash = strrchr(file_path, '/');
  if (last_slash == NULL || !strict_basename(last_slash + 1)) return RESULT_INVALID_PATH;
  size_t parent_length = (size_t)(last_slash - file_path);
  if (parent_length == 0U) parent_length = 1U;
  memcpy(parent, file_path, parent_length);
  parent[parent_length] = '\0';
  size_t basename_length = length - (size_t)(last_slash - file_path) - 1U;
  memcpy(basename, last_slash + 1, basename_length + 1U);
  return RESULT_OK;
}

static bool parse_identity(const char *value, uintmax_t *identity) {
  if (value[0] == '\0' || value[0] == '-') return false;
  errno = 0;
  char *end = NULL;
  uintmax_t parsed = strtoumax(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return false;
  *identity = parsed;
  return true;
}

static bool identity_matches(const struct stat *status, uintmax_t device, uintmax_t inode) {
  return (uintmax_t)status->st_dev == device && (uintmax_t)status->st_ino == inode;
}

static void print_json_string(const char *value) {
  (void)putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1) {
    switch (*cursor) {
      case '"': (void)fputs("\\\"", stdout); break;
      case '\\': (void)fputs("\\\\", stdout); break;
      case '\b': (void)fputs("\\b", stdout); break;
      case '\f': (void)fputs("\\f", stdout); break;
      case '\n': (void)fputs("\\n", stdout); break;
      case '\r': (void)fputs("\\r", stdout); break;
      case '\t': (void)fputs("\\t", stdout); break;
      default:
        if (*cursor < 0x20U) (void)printf("\\u%04x", (unsigned int)*cursor);
        else (void)putchar((int)*cursor);
        break;
    }
  }
  (void)putchar('"');
}

static result_code open_verified_directory(
  const char *directory_path,
  uintmax_t expected_device,
  uintmax_t expected_inode,
  int *directory_fd
) {
  result_code result = open_directory_components(directory_path, directory_fd);
  if (result != RESULT_OK) return result;
  struct stat directory_status;
  if (fstat_nointr(*directory_fd, &directory_status) != 0 || !S_ISDIR(directory_status.st_mode)) {
    (void)close_nointr(*directory_fd);
    return RESULT_INVALID_PATH;
  }
  if (!identity_matches(&directory_status, expected_device, expected_inode)) {
    (void)close_nointr(*directory_fd);
    return RESULT_IDENTITY_MISMATCH;
  }
  return RESULT_OK;
}

static result_code open_source_file(const char *temporary_path, int *source_fd) {
  size_t temporary_length = bounded_length(temporary_path, CAP_PATH_MAX + 1U);
  if (temporary_length < 2U || temporary_length > CAP_PATH_MAX || temporary_path[0] != '/') {
    return RESULT_SOURCE_INVALID;
  }
  *source_fd = open_nointr(temporary_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (*source_fd < 0) {
    return RESULT_SOURCE_INVALID;
  }
  struct stat source_status;
  if (
    fstat_nointr(*source_fd, &source_status) != 0
    || !S_ISREG(source_status.st_mode)
    || source_status.st_size < 0
  ) {
    (void)close_nointr(*source_fd);
    return RESULT_SOURCE_INVALID;
  }
  if ((uint64_t)source_status.st_size > MAX_FILE_BYTES) {
    (void)close_nointr(*source_fd);
    return RESULT_FILE_TOO_LARGE;
  }
  return RESULT_OK;
}

static result_code open_relative_parent(
  int root_fd,
  const char *relative_path,
  int *parent_fd,
  char basename[CAP_NAME_MAX + 1U]
) {
  size_t length = bounded_length(relative_path, CAP_PATH_MAX + 1U);
  if (
    length == 0U
    || length > CAP_PATH_MAX
    || relative_path[0] == '/'
    || relative_path[length - 1U] == '/'
  ) {
    (void)close_nointr(root_fd);
    return RESULT_INVALID_PATH;
  }
  int current = root_fd;
  size_t cursor = 0U;
  size_t components = 0U;
  while (cursor < length) {
    const size_t start = cursor;
    while (cursor < length && relative_path[cursor] != '/') cursor += 1U;
    char component[CAP_NAME_MAX + 1U];
    result_code result = copy_component(relative_path + start, cursor - start, component);
    if (result != RESULT_OK || ++components > CAP_COMPONENT_MAX) {
      (void)close_nointr(current);
      return RESULT_INVALID_PATH;
    }
    if (cursor == length) {
      memcpy(basename, component, strlen(component) + 1U);
      *parent_fd = current;
      return RESULT_OK;
    }
    int next = openat_nointr(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0);
    if (next < 0) {
      (void)close_nointr(current);
      return RESULT_INVALID_PATH;
    }
    (void)close_nointr(current);
    current = next;
    cursor += 1U;
    if (cursor == length || relative_path[cursor] == '/') {
      (void)close_nointr(current);
      return RESULT_INVALID_PATH;
    }
  }
  (void)close_nointr(current);
  return RESULT_INVALID_PATH;
}

static result_code copy_source(int source_fd, int destination_fd, uint64_t *total) {
  unsigned char buffer[COPY_BUFFER_SIZE];
  *total = 0U;
  for (;;) {
    ssize_t read_count;
    do {
      read_count = read(source_fd, buffer, sizeof buffer);
    } while (read_count < 0 && errno == EINTR);
    if (read_count < 0) return RESULT_IO_ERROR;
    if (read_count == 0) return RESULT_OK;
    if ((uint64_t)read_count > MAX_FILE_BYTES - *total) return RESULT_FILE_TOO_LARGE;
    size_t offset = 0U;
    while (offset < (size_t)read_count) {
      ssize_t write_count;
      do {
        write_count = write(destination_fd, buffer + offset, (size_t)read_count - offset);
      } while (write_count < 0 && errno == EINTR);
      if (write_count <= 0) return RESULT_IO_ERROR;
      offset += (size_t)write_count;
      *total += (uint64_t)write_count;
    }
  }
}

static bool path_matches_created_file(
  int directory_fd,
  const char *basename,
  const struct stat *created_status
) {
  struct stat path_status;
  return fstatat_nointr(directory_fd, basename, &path_status, AT_SYMLINK_NOFOLLOW) == 0
    && S_ISREG(path_status.st_mode)
    && path_status.st_dev == created_status->st_dev
    && path_status.st_ino == created_status->st_ino;
}

static bool remove_created_file(
  int directory_fd,
  const char *basename,
  const struct stat *created_status
) {
  return path_matches_created_file(directory_fd, basename, created_status)
    && unlinkat_nointr(directory_fd, basename) == 0
    && fsync_nointr(directory_fd) == 0;
}

static result_code commit_no_replace_at(
  int directory_fd,
  int source_fd,
  const char *basename
) {
  if (!strict_basename(basename)) {
    (void)close_nointr(source_fd);
    (void)close_nointr(directory_fd);
    return RESULT_INVALID_REQUEST;
  }
  int destination_fd = openat_nointr(
    directory_fd,
    basename,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    S_IRUSR | S_IWUSR
  );
  if (destination_fd < 0) {
    result_code result = errno == EEXIST ? RESULT_PATH_EXISTS : RESULT_IO_ERROR;
    (void)close_nointr(source_fd);
    (void)close_nointr(directory_fd);
    return result;
  }
  struct stat created_status;
  if (fstat_nointr(destination_fd, &created_status) != 0 || !S_ISREG(created_status.st_mode)) {
    (void)close_nointr(source_fd);
    (void)close_nointr(destination_fd);
    (void)close_nointr(directory_fd);
    return RESULT_COMMIT_INDETERMINATE;
  }
  uint64_t total = 0U;
  result_code result = copy_source(source_fd, destination_fd, &total);
  (void)close_nointr(source_fd);
  if (result == RESULT_OK && fsync_nointr(destination_fd) != 0) result = RESULT_IO_ERROR;
  if (close_nointr(destination_fd) != 0 && result == RESULT_OK) result = RESULT_IO_ERROR;
  if (result == RESULT_OK && fsync_nointr(directory_fd) != 0) result = RESULT_IO_ERROR;
  if (
    result == RESULT_OK
    && !path_matches_created_file(directory_fd, basename, &created_status)
  ) {
    result = RESULT_COMMIT_INDETERMINATE;
  }
  if (
    result != RESULT_OK
    && result != RESULT_COMMIT_INDETERMINATE
    && !remove_created_file(directory_fd, basename, &created_status)
  ) {
    result = RESULT_COMMIT_INDETERMINATE;
  }
  (void)close_nointr(directory_fd);
  return result;
}

static result_code commit_no_replace(
  const char *directory_path,
  uintmax_t expected_device,
  uintmax_t expected_inode,
  const char *basename,
  const char *temporary_path
) {
  int directory_fd = -1;
  result_code result = open_verified_directory(
    directory_path,
    expected_device,
    expected_inode,
    &directory_fd
  );
  if (result != RESULT_OK) return result;
  int source_fd = -1;
  result = open_source_file(temporary_path, &source_fd);
  if (result != RESULT_OK) {
    (void)close_nointr(directory_fd);
    return result;
  }
  return commit_no_replace_at(directory_fd, source_fd, basename);
}

static result_code commit_directory(
  const char *root_path,
  uintmax_t expected_device,
  uintmax_t expected_inode,
  const char *relative_path,
  const char *temporary_path
) {
  int root_fd = -1;
  result_code result = open_verified_directory(
    root_path,
    expected_device,
    expected_inode,
    &root_fd
  );
  if (result != RESULT_OK) return result;
  int parent_fd = -1;
  char basename[CAP_NAME_MAX + 1U];
  result = open_relative_parent(root_fd, relative_path, &parent_fd, basename);
  if (result != RESULT_OK) return result;
  int source_fd = -1;
  result = open_source_file(temporary_path, &source_fd);
  if (result != RESULT_OK) {
    (void)close_nointr(parent_fd);
    return result;
  }
  return commit_no_replace_at(parent_fd, source_fd, basename);
}

static result_code commit_retained_file(
  int destination_fd,
  uintmax_t expected_device,
  uintmax_t expected_inode,
  const char *temporary_path
) {
  struct stat destination_status;
  if (
    fstat_nointr(destination_fd, &destination_status) != 0
    || !S_ISREG(destination_status.st_mode)
    || !identity_matches(&destination_status, expected_device, expected_inode)
  ) {
    return RESULT_TARGET_CHANGED;
  }
  int source_fd = -1;
  result_code result = open_source_file(temporary_path, &source_fd);
  if (result != RESULT_OK) return result;
  if (lseek(destination_fd, 0, SEEK_SET) < 0) {
    (void)close_nointr(source_fd);
    return RESULT_COMMIT_INDETERMINATE;
  }
  uint64_t total = 0U;
  result = copy_source(source_fd, destination_fd, &total);
  (void)close_nointr(source_fd);
  if (result == RESULT_OK) {
    if (ftruncate(destination_fd, (off_t)total) != 0) result = RESULT_IO_ERROR;
  }
  if (result == RESULT_OK && fsync_nointr(destination_fd) != 0) result = RESULT_IO_ERROR;
  struct stat final_status;
  if (
    result == RESULT_OK
    && (
      fstat_nointr(destination_fd, &final_status) != 0
      || final_status.st_nlink == 0
    )
  ) {
    result = RESULT_IO_ERROR;
  }
  if (result != RESULT_OK) return RESULT_COMMIT_INDETERMINATE;
  return result;
}

static result_code stat_directory(const char *path) {
  int fd = -1;
  result_code result = open_directory_components(path, &fd);
  if (result != RESULT_OK) return result;
  struct stat status;
  if (fstat_nointr(fd, &status) != 0 || !S_ISDIR(status.st_mode)) result = RESULT_INVALID_PATH;
  else {
    (void)printf(
      "{\"ok\":true,\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\"}\n",
      (uintmax_t)status.st_dev,
      (uintmax_t)status.st_ino
    );
  }
  (void)close_nointr(fd);
  return result;
}

static result_code stat_file(const char *path) {
  char parent[CAP_PATH_MAX + 1U];
  char basename[CAP_NAME_MAX + 1U];
  result_code result = split_file_path(path, parent, basename);
  if (result != RESULT_OK) return result;
  int parent_fd = -1;
  result = open_directory_components(parent, &parent_fd);
  if (result != RESULT_OK) return result;
  struct stat parent_status;
  if (fstat_nointr(parent_fd, &parent_status) != 0 || !S_ISDIR(parent_status.st_mode)) {
    (void)close_nointr(parent_fd);
    return RESULT_INVALID_PATH;
  }
  struct stat target_status;
  int target_result = fstatat_nointr(parent_fd, basename, &target_status, AT_SYMLINK_NOFOLLOW);
  if (target_result != 0 && errno != ENOENT) {
    (void)close_nointr(parent_fd);
    return RESULT_INVALID_PATH;
  }
  if (target_result == 0 && !S_ISREG(target_status.st_mode)) {
    (void)close_nointr(parent_fd);
    return RESULT_INVALID_PATH;
  }
  (void)printf(
    "{\"ok\":true,\"parentDev\":\"%" PRIuMAX "\",\"parentIno\":\"%" PRIuMAX "\",\"basename\":",
    (uintmax_t)parent_status.st_dev,
    (uintmax_t)parent_status.st_ino
  );
  print_json_string(basename);
  if (target_result == 0) {
    (void)printf(
      ",\"file\":{\"dev\":\"%" PRIuMAX "\",\"ino\":\"%" PRIuMAX "\"}}\n",
      (uintmax_t)target_status.st_dev,
      (uintmax_t)target_status.st_ino
    );
  } else {
    (void)fputs(",\"file\":null}\n", stdout);
  }
  (void)close_nointr(parent_fd);
  return RESULT_OK;
}

static int finish(result_code result, bool output_already_written) {
  if (result != RESULT_OK) {
    (void)printf("{\"ok\":false,\"code\":\"%s\"}\n", result_name(result));
  } else if (!output_already_written) {
    (void)fputs("{\"ok\":true}\n", stdout);
  }
  if (fflush(stdout) != 0) return RESULT_IO_ERROR;
  return (int)result;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "self-test") == 0) {
    int root_fd = -1;
    result_code result = open_directory_components("/", &root_fd);
    if (root_fd >= 0) (void)close_nointr(root_fd);
    return finish(result, false);
  }
  if (argc == 3 && strcmp(argv[1], "stat-directory") == 0) {
    result_code result = stat_directory(argv[2]);
    return finish(result, result == RESULT_OK);
  }
  if (argc == 3 && strcmp(argv[1], "stat-file") == 0) {
    result_code result = stat_file(argv[2]);
    return finish(result, result == RESULT_OK);
  }
  if (argc == 7 && strcmp(argv[1], "commit-directory") == 0) {
    uintmax_t expected_device;
    uintmax_t expected_inode;
    if (!parse_identity(argv[3], &expected_device) || !parse_identity(argv[4], &expected_inode)) {
      return finish(RESULT_INVALID_REQUEST, false);
    }
    result_code result = commit_directory(argv[2], expected_device, expected_inode, argv[5], argv[6]);
    return finish(result, false);
  }
  if (argc == 7 && strcmp(argv[1], "commit-file") == 0) {
    uintmax_t expected_parent_device;
    uintmax_t expected_parent_inode;
    if (
      !parse_identity(argv[3], &expected_parent_device)
      || !parse_identity(argv[4], &expected_parent_inode)
      || !strict_basename(argv[5])
    ) {
      return finish(RESULT_INVALID_REQUEST, false);
    }
    result_code result = commit_no_replace(
      argv[2],
      expected_parent_device,
      expected_parent_inode,
      argv[5],
      argv[6]
    );
    return finish(result, false);
  }
  if (argc == 5 && strcmp(argv[1], "commit-retained-file") == 0) {
    uintmax_t expected_file_device;
    uintmax_t expected_file_inode;
    if (!parse_identity(argv[2], &expected_file_device) || !parse_identity(argv[3], &expected_file_inode)) {
      return finish(RESULT_INVALID_REQUEST, false);
    }
    result_code result = commit_retained_file(
      3,
      expected_file_device,
      expected_file_inode,
      argv[4]
    );
    return finish(result, false);
  }
  return finish(RESULT_INVALID_REQUEST, false);
}

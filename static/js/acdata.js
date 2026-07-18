'use strict';

// ── acdata.js ─────────────────────────────────────────────────────────────────
// Standard-library completion data, generated from the local toolchains:
//   Go:     `go doc <pkg>` (exported funcs of common stdlib packages)
//   Python: `dir(__builtins__)`
// Loaded before autocomplete.js, which consumes these tables.

// Go stdlib: suggested after `pkg.` (e.g. `fmt.Pr` → Println).
const AC_GO_PKGS = {
  fmt: ['Append','Appendf','Appendln','Errorf','FormatString','Fprint','Fprintf','Fprintln','Fscan','Fscanf','Fscanln','Print','Printf','Println','Scan','Scanf','Scanln','Sprint','Sprintf','Sprintln','Sscan','Sscanf','Sscanln'],
  strings: ['Clone','Compare','Contains','ContainsAny','ContainsFunc','ContainsRune','Count','Cut','CutPrefix','CutSuffix','EqualFold','Fields','FieldsFunc','FieldsFuncSeq','FieldsSeq','HasPrefix','HasSuffix','Index','IndexAny','IndexByte','IndexFunc','IndexRune','Join','LastIndex','LastIndexAny','LastIndexByte','LastIndexFunc','Lines','Map','Repeat','Replace','ReplaceAll','Split','SplitAfter','SplitAfterN','SplitAfterSeq','SplitN','SplitSeq','Title','ToLower','ToLowerSpecial','ToTitle','ToTitleSpecial','ToUpper','ToUpperSpecial','ToValidUTF8','Trim','TrimFunc','TrimLeft','TrimLeftFunc','TrimPrefix','TrimRight','TrimRightFunc','TrimSpace','TrimSuffix'],
  strconv: ['AppendBool','AppendFloat','AppendInt','AppendQuote','AppendQuoteRune','AppendQuoteRuneToASCII','AppendQuoteRuneToGraphic','AppendQuoteToASCII','AppendQuoteToGraphic','AppendUint','Atoi','CanBackquote','FormatBool','FormatComplex','FormatFloat','FormatInt','FormatUint','IsGraphic','IsPrint','Itoa','ParseBool','ParseComplex','ParseFloat','ParseInt','ParseUint','Quote','QuoteRune','QuoteRuneToASCII','QuoteRuneToGraphic','QuoteToASCII','QuoteToGraphic','QuotedPrefix','Unquote','UnquoteChar'],
  os: ['Chdir','Chmod','Chown','Chtimes','Clearenv','CopyFS','DirFS','Environ','Executable','Exit','Expand','ExpandEnv','Getegid','Getenv','Geteuid','Getgid','Getgroups','Getpagesize','Getpid','Getppid','Getuid','Getwd','Hostname','IsExist','IsNotExist','IsPathSeparator','IsPermission','IsTimeout','Lchown','Link','LookupEnv','Mkdir','MkdirAll','MkdirTemp','NewSyscallError','Pipe','ReadFile','Readlink','Remove','RemoveAll','Rename','SameFile','Setenv','Symlink','TempDir','Truncate','Unsetenv','UserCacheDir','UserConfigDir','UserHomeDir','WriteFile'],
  time: ['After','Sleep','Tick','Now','Since','Until','Parse','ParseDuration','Date','Unix','UnixMilli','UnixMicro','NewTimer','NewTicker','AfterFunc'],
  errors: ['As','AsType','Is','Join','New','Unwrap'],
  math: ['Abs','Acos','Acosh','Asin','Asinh','Atan','Atan2','Atanh','Cbrt','Ceil','Copysign','Cos','Cosh','Dim','Exp','Exp2','Expm1','Floor','Hypot','Inf','IsInf','IsNaN','Log','Log10','Log1p','Log2','Max','Min','Mod','Modf','NaN','Pow','Pow10','Remainder','Round','RoundToEven','Signbit','Sin','Sincos','Sinh','Sqrt','Tan','Tanh','Trunc'],
  sort: ['Find','Float64s','Float64sAreSorted','Ints','IntsAreSorted','IsSorted','Search','SearchFloat64s','SearchInts','SearchStrings','Slice','SliceIsSorted','SliceStable','Sort','Stable','Strings','StringsAreSorted'],
};

// Python builtins (functions get () on accept; exception classes stay bare).
const AC_PY_BUILTINS = [
  'abs','aiter','all','anext','any','ascii','bin','bool','breakpoint','bytearray',
  'bytes','callable','chr','classmethod','compile','complex','delattr','dict','dir',
  'divmod','enumerate','eval','exec','filter','float','format','frozenset','getattr',
  'globals','hasattr','hash','help','hex','id','input','int','isinstance','issubclass',
  'iter','len','list','locals','map','max','memoryview','min','next','object','oct',
  'open','ord','pow','print','property','range','repr','reversed','round','set',
  'setattr','slice','sorted','staticmethod','str','sum','super','tuple','type','vars','zip',
  'Exception','ValueError','TypeError','KeyError','IndexError','AttributeError',
  'RuntimeError','StopIteration','FileNotFoundError','PermissionError','OSError',
  'ZeroDivisionError','NotImplementedError','KeyboardInterrupt','TimeoutError',
];

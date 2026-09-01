# Test fixtures

Binary inputs for the VBA import tests (`tests/vba-import.test.ts`).

## `vbaProject.bin`

A genuine, Excel-produced VBA project containing one code module
(`Module1.say_hello`) plus the usual `ThisWorkbook` and `Sheet1` document
modules.

Taken from the test suite of [XlsxWriter](https://github.com/jmcnamara/XlsxWriter)
(`xlsxwriter/test/comparison/xlsx_files/vbaProject02.bin`), which is
distributed under the BSD 2-Clause License:

> Copyright (c) 2013-2025, John McNamara <jmcnamara@cpan.org>
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
>    this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

Why a real file rather than a generated one: the container's allocation
tables, the mini-stream layout, the declared code page and the compressed
module streams are all shaped the way Office actually writes them. A fixture
we generated ourselves would only prove the readers agree with our own
writer. Both are used — see `tests/vba-fixtures.ts` for the synthetic
projects, which cover the cases this file cannot reach (a Hebrew code page,
an auto-run macro).

The macro it contains is inert: an empty `Sub say_hello()`. Nothing in the
toolkit executes VBA.

## `with-macros.docm`

A minimal macro-enabled Word package wrapping the `vbaProject.bin` above:
`[Content_Types].xml` with the `macroEnabled.main` override, a one-paragraph
`word/document.xml`, and the `vbaProject` relationship that points at the
macro part. Every entry is deflate-compressed, so reading it exercises
inflation rather than a stored-entry passthrough.

Written for this repository.

## `no-macros.docx`

The same minimal package with no macro part — the negative case for
`extractVbaFromDocx`, which must answer `no-macros` rather than fail.

Written for this repository.
